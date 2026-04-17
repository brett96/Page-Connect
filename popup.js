/**
 * Popup UI for Page Connect.
 * Validates inputs, persists config, and coordinates with the service worker via messaging.
 */

const STORAGE_KEY = "pageConnectConfig";
/** Legacy key from pre-rebrand builds — migrated once on load. */
const LEGACY_STORAGE_KEY = "walmartSniperConfig";

const MSG = {
  START: "PAGE_CONNECT_START",
  CANCEL: "PAGE_CONNECT_CANCEL",
  STATUS: "PAGE_CONNECT_STATUS",
  DONE: "PAGE_CONNECT_DONE",
  PING: "PAGE_CONNECT_PING",
};

const ACTIVE_KEY = "pageConnectActive";
/** Legacy active flag — cleared when migrating. */
const LEGACY_ACTIVE_KEY = "sniperActive";

/** @type {HTMLInputElement} */
const elUrl = document.getElementById("targetUrl");
/** @type {HTMLInputElement} */
const elDateTime = document.getElementById("targetDateTime");
/** @type {HTMLSelectElement} */
const elTimeZone = document.getElementById("timeZone");
/** @type {HTMLButtonElement} */
const elToggle = document.getElementById("btnToggle");
/** @type {HTMLDivElement} */
const elStatus = document.getElementById("status");
/** @type {HTMLSpanElement} */
const elBadge = document.getElementById("statusBadge");

/** @type {"idle" | "running" | "error"} */
let uiState = "idle";
/** True if the UI believes a run is active (guards against late STATUS messages after Stop). */
let shouldBeRunning = false;

/**
 * Allows normal http(s) page URLs only (no javascript:, file:, etc.).
 * @param {string} raw
 * @returns {boolean}
 */
function isValidHttpPageUrl(raw) {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    if (!u.hostname) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Converts a datetime-local string (no timezone) + IANA zone to UTC epoch milliseconds.
 * Prefers `Temporal` when available (fast, DST-correct). Otherwise a bounded ±20h per-second scan
 * (far smaller than a 72h scan) so the popup thread stays responsive on slow devices.
 * @param {string} dateTimeLocal e.g. "2026-04-16T14:30"
 * @param {string} timeZone e.g. "America/Los_Angeles"
 * @returns {number | null}
 */
function zonedLocalToUtcMs(dateTimeLocal, timeZone) {
  const trimmed = dateTimeLocal.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(trimmed);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = m[6] != null ? Number(m[6]) : 0;
  const target = [y, mo, d, h, mi, s];

  const normalized = trimmed.length === 16 ? `${trimmed}:00` : trimmed;
  const T = globalThis.Temporal;
  if (T?.PlainDateTime?.from) {
    try {
      const plain = T.PlainDateTime.from(normalized);
      const zdt = plain.toZonedDateTime(timeZone);
      return zdt.epochMilliseconds;
    } catch {
      /* fall through to Intl scan */
    }
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  /** @param {number} t */
  const readZonedParts = (t) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(t)).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
    );
    return [Number(parts.year), Number(parts.month), Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second ?? 0)];
  };

  /** @param {number[]} a @param {number[]} b */
  const eq = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3] && a[4] === b[4] && a[5] === b[5];

  const anchor = Date.UTC(y, mo - 1, d, h, mi, s, 0);
  const maxSec = 20 * 3600;
  for (let ds = -maxSec; ds <= maxSec; ds++) {
    const t = anchor + ds * 1000;
    if (eq(readZonedParts(t), target)) return t;
  }
  return null;
}

/**
 * @param {string} text
 */
function setStatus(text) {
  elStatus.textContent = text;
}

/**
 * @param {string} sub
 */
function setIdle(sub) {
  elStatus.innerHTML = `<strong>Idle.</strong>\n${sub}`;
}

/**
 * @param {"idle" | "running" | "error"} state
 * @param {string} label
 */
function setBadge(state, label) {
  uiState = state;
  elBadge.textContent = label;
  elBadge.classList.remove("badge-idle", "badge-running", "badge-error");
  elBadge.classList.add(state === "running" ? "badge-running" : state === "error" ? "badge-error" : "badge-idle");
}

function setRunningUi(running) {
  elUrl.disabled = running;
  elDateTime.disabled = running;
  elTimeZone.disabled = running;

  shouldBeRunning = running;
  if (running) {
    elToggle.textContent = "Stop";
    elToggle.classList.remove("btn-primary");
    elToggle.classList.add("btn-danger");
    setBadge("running", "Running");
  } else {
    elToggle.textContent = "Start";
    elToggle.classList.remove("btn-danger");
    elToggle.classList.add("btn-primary");
    if (uiState !== "error") setBadge("idle", "Idle");
  }
}

async function loadSaved() {
  try {
    const data = await chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY, ACTIVE_KEY, LEGACY_ACTIVE_KEY]);
    let cfg = data[STORAGE_KEY];
    if (!cfg && data[LEGACY_STORAGE_KEY]) {
      cfg = data[LEGACY_STORAGE_KEY];
      await chrome.storage.local.set({ [STORAGE_KEY]: cfg });
      await chrome.storage.local.remove(LEGACY_STORAGE_KEY);
    }
    if (data[LEGACY_ACTIVE_KEY] && !data[ACTIVE_KEY]) {
      await chrome.storage.local.set({ [ACTIVE_KEY]: data[LEGACY_ACTIVE_KEY] });
      await chrome.storage.local.remove(LEGACY_ACTIVE_KEY);
    }
    if (cfg && typeof cfg === "object") {
      if (typeof cfg.targetUrl === "string") elUrl.value = cfg.targetUrl;
      if (typeof cfg.targetDateTime === "string") elDateTime.value = cfg.targetDateTime;
      if (typeof cfg.timeZone === "string") elTimeZone.value = cfg.timeZone;
    }
  } catch (e) {
    console.error("loadSaved", e);
  }
}

async function startFlow() {
  const targetUrl = elUrl.value.trim();
  const targetDateTime = elDateTime.value;
  const timeZone = elTimeZone.value;

  if (!targetUrl) {
    setBadge("error", "Error");
    setStatus("Please enter a Target URL.");
    return;
  }
  if (!isValidHttpPageUrl(targetUrl)) {
    setBadge("error", "Error");
    setStatus("Invalid URL. Use an http(s) link, e.g. https://example.com/…");
    return;
  }
  if (!targetDateTime) {
    setBadge("error", "Error");
    setStatus("Please choose a target date and time.");
    return;
  }

  const targetEpochMs = zonedLocalToUtcMs(targetDateTime, timeZone);
  if (targetEpochMs == null || !Number.isFinite(targetEpochMs)) {
    setBadge("error", "Error");
    setStatus("Could not parse the target time for the selected timezone.");
    return;
  }

  const now = Date.now();
  if (targetEpochMs <= now) {
    setBadge("error", "Error");
    setStatus("Target time must be in the future.");
    return;
  }

  // Need at least ~1 minute + ping window headroom (Phase 2 starts at T-60s, pings take ~30s).
  const minLead = 65_000;
  if (targetEpochMs - now < minLead) {
    setBadge("error", "Error");
    setStatus(`Target must be at least ${Math.ceil(minLead / 1000)} seconds from now (pre-wait + latency pings).`);
    return;
  }

  const config = { targetUrl, targetDateTime, timeZone, targetEpochMs, savedAt: now };

  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: config, [ACTIVE_KEY]: true });
  } catch (e) {
    console.error("storage set", e);
    setBadge("error", "Error");
    setStatus("Could not save settings to storage.");
    return;
  }

  setRunningUi(true);
  setStatus("Starting scheduled connect…");

  try {
    await chrome.runtime.sendMessage({ type: MSG.START, payload: config });
  } catch (e) {
    console.error("sendMessage", e);
    setBadge("error", "Error");
    setStatus("Could not reach the background worker. Try reloading the extension.");
    setRunningUi(false);
    await chrome.storage.local.set({ [ACTIVE_KEY]: false });
  }
}

async function stopFlow() {
  // Immediately flip local state so any late STATUS messages don't revert the badge.
  shouldBeRunning = false;
  try {
    await chrome.runtime.sendMessage({ type: MSG.CANCEL });
  } catch (e) {
    console.error("cancel message", e);
  }
  setRunningUi(false);
  setBadge("idle", "Idle");
  setIdle("Cancelled.");
}

elToggle.addEventListener("click", async () => {
  if (uiState === "running") {
    await stopFlow();
  } else {
    // Clear previous error badge when user retries.
    setBadge("idle", "Idle");
    await startFlow();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === MSG.STATUS && typeof msg.text === "string") {
    if (shouldBeRunning) setBadge("running", "Running");
    setStatus(msg.text);
  }
  if (msg.type === MSG.DONE) {
    shouldBeRunning = false;
    setRunningUi(false);
    if (msg.success === false) {
      setBadge("error", "Error");
      if (typeof msg.text === "string") setStatus(msg.text);
    } else {
      setBadge("idle", "Idle");
      if (typeof msg.text === "string") setStatus(msg.text);
      else setIdle("Ready.");
    }
  }
});

/**
 * Aligns the popup with the service worker so a stale `pageConnectActive` flag after reload/crash
 * does not leave the UI stuck in "in progress" forever.
 */
async function syncRunningStateWithBackground() {
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.PING });
    if (res?.isRunning) {
      setRunningUi(true);
      setStatus("Connect sequence in progress…");
      return;
    }
    setRunningUi(false);
    setIdle("Configure URL and time, then press Start.");
  } catch {
    await chrome.storage.local.set({ [ACTIVE_KEY]: false });
    setBadge("error", "Error");
    setRunningUi(false);
    setStatus("Background worker unavailable (reload the extension).");
  }
}

(async () => {
  await loadSaved();
  setBadge("idle", "Idle");
  await syncRunningStateWithBackground();
})();
