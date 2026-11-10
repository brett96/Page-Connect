/**
 * Service worker (Manifest V3) — Page Connect scheduling engine.
 *
 * Long waits use `chrome.alarms` so Chrome can suspend this worker without losing the schedule.
 * Latency pings use `HEAD` when possible (falls back to `GET`).
 * Launch uses a same-origin warmup tab (lightweight 404 HTML route) + `chrome.tabs.update` so the renderer
 * matches the target site (avoids extension-page to web process swap at navigation).
 *
 * Phases (conceptual):
 * 1) Reach T−60s (alarm at T−70s if the pre-wait is long).
 * 2) Open same-origin warmup tab, primer ping (discarded), then 4 measured pings at T−60s … T−30s (10s spacing).
 * 3) Average RTT; failures count as 0 ms for that sample.
 * 4) AdjustedLaunchTime = TargetTime − averageLatencyMs.
 * 5) At AdjustedLaunchTime, `tabs.update` + focus window (or `tabs.create` + focus if warmup failed).
 * 6) Optional notifications: if the user gave an email and/or phone, the launched tab is watched for
 *    up to 30 minutes. Each page load is classified in-page (human check / sign-in, waiting room,
 *    product or checkout page) and bretttomita.com/api/page-connect/notify sends "connected" on the
 *    first load, "verify" when a check or sign-in needs the user, and "arrived" on the product page.
 * Retail drops (retailers.js): the store's homepage opens at T−5 min so the user can sign in and
 * clear any human check while nothing is at stake. That tab is watched for checks (attention.js
 * brings it to the front with a chime and a desktop notification) and then becomes the launch tab;
 * it isn't reloaded, and latency is timed with GETs for a static asset.
 * 7) Stock watch (watch.js): on supported retail sites, keep re-checking a product page and add the
 *    item to the cart when it becomes available — either straight away ("watch" mode) or on the
 *    tab a scheduled launch just opened.
 */

import { retailerFor } from "./retailers.js";
import { PAGE_SIGNALS, hasContact, sendNotify } from "./shared.js";
import {
  ATTENTION_REPEAT_MS,
  REMOTE_VERIFY_MAX,
  REMOTE_VERIFY_MS,
  clearAttention,
  demandAttention,
  handleAttentionClick,
} from "./attention.js";
import {
  WATCH_ALARM,
  getWatch,
  handleNotificationClick,
  handleWatchAlarm,
  handleWatchTabRemoved,
  runCheck,
  startWatch,
  stopWatch,
} from "./watch.js";

const MSG = {
  START: "PAGE_CONNECT_START",
  CANCEL: "PAGE_CONNECT_CANCEL",
  STATUS: "PAGE_CONNECT_STATUS",
  DONE: "PAGE_CONNECT_DONE",
  PING: "PAGE_CONNECT_PING",
};

const ACTIVE_KEY = "pageConnectActive";
/** Persisted job while alarms may outlive the worker. */
const RUN_KEY = "pageConnectRun";

/** Launched tab being watched for notifications: { tabId, targetUrl, notify, sent, until }. */
const MONITOR_KEY = "pageConnectMonitor";
const MONITOR_MS = 30 * 60_000;

/** Fires ~10s before T−60s so we can wake, then fine-wait to T−60s. */
const ALARM_PRE_LATENCY = "pageConnectAlarmPreLatency";
/** Retail drops: opens the store at T−5 min for sign-in and checks. */
const ALARM_PREP = "pageConnectAlarmPrep";
const RETAIL_PREP_MS = 5 * 60_000;
/** Fires well before adjusted launch so a cold service-worker boot still has time to spin. */
const ALARM_PRE_LAUNCH = "pageConnectAlarmPreLaunch";

/** If waiting longer than this until T−60s or until launch, delegate to `chrome.alarms`. */
const LONG_WAIT_MS = 120_000;
/**
 * OS-level alarm timers can be delayed under power-saving / load.
 * Use a large runway (T−3 minutes) so we can bridge precisely with JS timers.
 */
const T180_MS_BEFORE_TARGET = 180_000;
/** ~15s runway: SW cold start under load can exceed 1–3s; 2s was too tight. */
const PRE_LAUNCH_LEAD_MS = 15_000;
/** Keep-alive heartbeat interval to reduce CDN/keep-alive socket drops. */
const HEARTBEAT_MS = 8_000;
/** Stop heartbeats shortly before launch so they don’t contend with navigation. */
const HEARTBEAT_CUTOFF_MS = 2_000;
/**
 * Chrome extension APIs cross process boundaries (IPC) before the renderer navigates.
 * This adds a small, consistent delay on most machines; subtracting it helps hit the server on-time.
 */
const IPC_FALLBACK_MS = 12;

/** @type {{ cancel: boolean } | null} */
let session = null;

/**
 * OS sleep / low-power states can destroy timer precision.
 * Request that the display stay awake during the critical countdown windows.
 */
let powerLockHeld = false;
function lockPowerAwake() {
  try {
    chrome.power?.requestKeepAwake?.("display");
    powerLockHeld = true;
  } catch {
    /* ignore */
  }
}
function releasePowerAwake() {
  if (!powerLockHeld) return;
  try {
    chrome.power?.releaseKeepAwake?.();
  } catch {
    /* ignore */
  } finally {
    powerLockHeld = false;
  }
}

function notifyStatus(text) {
  chrome.runtime.sendMessage({ type: MSG.STATUS, text }).catch(() => {});
}

function notifyDone(text, success) {
  chrome.runtime.sendMessage({ type: MSG.DONE, text, success }).catch(() => {});
}

function clearSession() {
  if (session) session.cancel = true;
  session = null;
}

async function clearOurAlarms() {
  await Promise.all([
    chrome.alarms.clear(ALARM_PRE_LATENCY),
    chrome.alarms.clear(ALARM_PRE_LAUNCH),
    chrome.alarms.clear(ALARM_PREP),
  ]);
}

/**
 * True if this worker currently has an in-memory run, or Chrome has scheduled one of our alarms.
 */
async function isOrchestrationActive() {
  if (session && !session.cancel) return true;
  const alarms = await chrome.alarms.getAll();
  return alarms.some((a) => a.name === ALARM_PRE_LATENCY || a.name === ALARM_PRE_LAUNCH || a.name === ALARM_PREP);
}

/**
 * Popup asks whether a connect is really running (fixes orphaned `ACTIVE_KEY` after reload/crash).
 */
async function handlePing() {
  const running = await isOrchestrationActive();
  if (!running) {
    await chrome.storage.local.set({ [ACTIVE_KEY]: false });
    await chrome.storage.local.remove(RUN_KEY);
  }
  const watch = await getWatch();
  return { isRunning: running, watching: Boolean(watch), watchText: watch?.statusText ?? null };
}

/**
 * Cooperative delay with cancellation. After each timer slice, touches `chrome.storage` so Chrome
 * does not treat the worker as idle for 30s+ during long waits (MV3 idle termination).
 * @param {number} ms
 * @param {{ cancel: boolean }} run
 */
async function delay(ms, run) {
  const end = Date.now() + Math.max(0, ms);
  while (Date.now() < end) {
    if (run.cancel) return;
    const left = end - Date.now();
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(250, Math.max(0, left)));
    });
    await chrome.storage.local.get(null).catch(() => {});
  }
}

/**
 * Fine-wait until `targetEpochMs`. Coarse phase uses wall-clock `Date.now()`; the final ≤50ms
 * uses `performance.now()` so the spin is monotonic and not skewed by NTP/system clock steps.
 * @param {number} targetEpochMs
 * @param {{ cancel: boolean }} run
 */
async function waitUntilEpoch(targetEpochMs, run) {
  const spinThresholdMs = 50;

  while (Date.now() < targetEpochMs) {
    if (run.cancel) return;

    const remaining = targetEpochMs - Date.now();
    if (remaining > spinThresholdMs) {
      await delay(remaining - spinThresholdMs, run);
      if (run.cancel) return;
    } else {
      const msUntilTarget = targetEpochMs - Date.now();
      if (msUntilTarget <= 0) return;
      const targetPerf = performance.now() + msUntilTarget;
      // Final spin: keep it purely primitive (no object/property reads) to avoid micro-stalls.
      while (performance.now() < targetPerf) {}
      return;
    }
  }
}

/**
 * RTT sample: prefer `HEAD` (headers only). Some hosts reject HEAD — fall back to `GET`.
 * @param {string} url
 * @returns {Promise<number>}
 */
async function pingOnce(url, getOnly = false) {
  const measure = async (method) => {
    const t0 = performance.now();
    const res = await fetch(url, {
      method,
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      priority: "high",
    });
    const t1 = performance.now();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return Math.max(0, t1 - t0);
  };

  try {
    if (getOnly) throw new Error("GET only");
    return await measure("HEAD");
  } catch (e1) {
    try {
      return await measure("GET");
    } catch (e2) {
      console.warn("pingOnce failed (HEAD and GET), using 0ms sample:", e1, e2);
      return 0;
    }
  }
}

/**
 * Primer ping warms TCP/TLS + HTTP keep-alive; result is discarded so the average is not inflated
 * by cold-handshake RTT. Then four measured pings, 10s apart.
 * @param {string} targetUrl
 * @param {{ cancel: boolean }} run
 * @returns {Promise<number>}
 */
async function runLatencySuite(targetUrl, run, getOnly = false) {
  notifyStatus("Warming connection (primer ping, discarded)…");
  await pingOnce(targetUrl, getOnly);
  if (run.cancel) return 0;

  const samples = [];
  for (let i = 0; i < 4; i++) {
    if (run.cancel) return samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;

    notifyStatus(`Pinging (${i + 1}/4)…`);
    samples.push(await pingOnce(targetUrl, getOnly));

    if (i < 3) {
      notifyStatus(`Waiting 10 seconds before next ping (${i + 1}/4 done)…`);
      await delay(10_000, run);
    }
  }
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

/** @param {Partial<{ targetUrl: string, targetEpochMs: number, warmupTabId: number | null, adjustedLaunchTime: number | null }>} patch */
async function mergeRunState(patch) {
  const cur = await chrome.storage.local.get(RUN_KEY);
  const base = cur[RUN_KEY] && typeof cur[RUN_KEY] === "object" ? cur[RUN_KEY] : {};
  await chrome.storage.local.set({ [RUN_KEY]: { ...base, ...patch } });
}

async function readRunState() {
  const data = await chrome.storage.local.get(RUN_KEY);
  return data[RUN_KEY] && typeof data[RUN_KEY] === "object" ? data[RUN_KEY] : null;
}

async function finalizeRunSuccess(message) {
  releasePowerAwake();
  await clearOurAlarms();
  await chrome.storage.local.remove(RUN_KEY);
  await chrome.storage.local.set({ [ACTIVE_KEY]: false });
  session = null;
  notifyDone(message, true);
}

async function finalizeRunFailure(message) {
  releasePowerAwake();
  await clearOurAlarms();
  const st = await chrome.storage.local.get(RUN_KEY);
  const wid = st[RUN_KEY]?.warmupTabId;
  if (typeof wid === "number") {
    try {
      await chrome.tabs.remove(wid);
    } catch {
      /* tab may already be gone */
    }
  }
  await chrome.storage.local.remove(RUN_KEY);
  await chrome.storage.local.set({ [ACTIVE_KEY]: false });
  session = null;
  notifyDone(message, false);
}

/**
 * Opens a background tab on the target origin (lightweight 404 HTML route) so Chrome uses the same renderer
 * process class as the final URL (avoids extension-page → site process swap at `tabs.update`).
 * @param {{ cancel: boolean }} run
 * @param {string} targetUrl
 * @returns {Promise<{ tabId: number, windowId: number | null, windowState: string | null } | null>} ids or null
 */
async function createWarmupTab(run, targetUrl, homepage = false) {
  if (run.cancel) return null;
  try {
    const targetOrigin = new URL(targetUrl).origin;
    // Use a unique fake path so most servers return a lightweight 404 HTML page.
    // This lets us inject an in-tab heartbeat that warms the *tab's* network partition.
    // Retail sites get their real homepage: WAFs tend to score made-up paths as probing.
    const warmupUrl = homepage ? `${targetOrigin}/` : `${targetOrigin}/_page_connect_warmup_${Date.now()}`;
    // (`muted` is not a `tabs.create` option; passing it makes the call throw.)
    const tab = await chrome.tabs.create({ url: warmupUrl, active: false });
    if (tab.id == null) return null;
    chrome.tabs.update(tab.id, { muted: true }).catch(() => {});
    // Resist Chrome Memory Saver tab discarding under heavy RAM pressure.
    try {
      await chrome.tabs.update(tab.id, { autoDiscardable: false });
    } catch {
      /* not supported on some channels/builds; ignore */
    }
    let windowState = null;
    if (tab.windowId != null) {
      try {
        const win = await chrome.windows.get(tab.windowId);
        windowState = win?.state ?? null;
      } catch {
        /* ignore */
      }
    }
    await mergeRunState({ warmupTabId: tab.id, warmupWindowId: tab.windowId ?? null, warmupWindowState: windowState });
    return { tabId: tab.id, windowId: tab.windowId ?? null, windowState };
  } catch (e) {
    console.warn("Warmup tab create failed:", e);
    return null;
  }
}

/**
 * Navigate the warmup tab to the target, or open a new tab if warmup is missing.
 * Fire-and-forget: dispatch IPC commands without awaiting responses (reduces T-0 overhead).
 * @param {string} targetUrl
 * @param {number | null | undefined} warmupTabId
 * @param {number | null | undefined} warmupWindowId
 * @param {string | null | undefined} warmupWindowState
 * @param {{ notify?: NotifyContact | null, watch?: { intervalSec: number } | null }} job
 */
function navigateToTarget(targetUrl, warmupTabId, warmupWindowId, warmupWindowState, job) {
  const notify = job?.notify;
  // Retail drop with "add to cart": the stock watch takes over the launched tab.
  const watchTab = (tabId) => {
    if (job?.watch) void startWatch({ url: targetUrl, tabId, autoCart: true, intervalSec: job.watch.intervalSec, notify });
  };
  if (typeof warmupTabId === "number") {
    chrome.tabs.update(warmupTabId, { url: targetUrl, active: true, muted: false }).catch(() => {});
    void startMonitor(warmupTabId, targetUrl, notify);
    watchTab(warmupTabId);
    if (typeof warmupWindowId === "number") {
      // Only restore/focus if we *know* the window was minimized.
      // Avoid focusing/adjusting otherwise; on Windows this can exit fullscreen or resize unexpectedly.
      if (warmupWindowState === "minimized") {
        chrome.windows.update(warmupWindowId, { focused: true, drawAttention: true, state: "normal" }).catch(() => {});
      }
    }
    return;
  }
  chrome.tabs
    .create({ url: targetUrl, active: true })
    .then((newTab) => {
      // Intentionally avoid `chrome.windows.update` here: if the destination window is fullscreen,
      // focusing can cause a resize/exit-fullscreen on some platforms. Activating the tab is enough.
      if (newTab.id != null) {
        void startMonitor(newTab.id, targetUrl, notify);
        watchTab(newTab.id);
      }
    })
    .catch(() => {});
}

/**
 * From T−60s: warmup tab, latency suite, then either schedule pre-launch alarm or launch inline.
 * @param {{ cancel: boolean }} run
 * @param {{ targetUrl: string, targetEpochMs: number, warmupTabId?: number | null, notify?: NotifyContact | null, watch?: { intervalSec: number } | null }} state
 */
async function executeFromT60(run, state) {
  lockPowerAwake();
  const { targetUrl, targetEpochMs } = state;
  const targetOrigin = new URL(targetUrl).origin;
  const shop = retailerFor(targetUrl);
  // Retail: time a static asset with plain GETs (some stores block HEAD or score it as a bot).
  const pingUrl = shop ? `${targetOrigin}${shop.pingPath}` : targetUrl;

  /** @type {{ tabId: number, windowId: number | null, windowState: string | null } | null} */
  let warm = null;
  if (typeof state.prepTabId === "number") {
    try {
      const t = await chrome.tabs.get(state.prepTabId);
      if (t.id != null) warm = { tabId: t.id, windowId: t.windowId ?? null, windowState: state.warmupWindowState ?? null };
      notifyStatus(`Launch will use the ${shop?.name ?? "store"} tab you signed in on (not reloaded).`);
    } catch {
      /* closed: open a fresh one below */
    }
  }
  if (!warm) {
    notifyStatus(shop ? `Opening ${shop.name} in a warm tab…` : "Opening warmup tab on target origin (warm 404)…");
    warm = await createWarmupTab(run, targetUrl, Boolean(shop));
  }
  const warmupTabId = warm?.tabId ?? null;
  const warmupWindowId = warm?.windowId ?? null;
  const warmupWindowState = warm?.windowState ?? null;
  if (warmupTabId == null) {
    notifyStatus("Warmup tab unavailable — will open the target in a new tab at launch.");
  }

  if (run.cancel) return;

  notifyStatus("Starting latency checks at T−60s…");
  const avgLatency = await runLatencySuite(pingUrl, run, Boolean(shop));
  if (run.cancel) return;

  // `avgLatency` is measured as RTT (round-trip). To target server-arrival time, approximate one-way transit as RTT/2.
  const oneWayLatency = avgLatency / 2;

  // Dynamically measure IPC overhead to the specific warm tab renderer.
  // `executeScript` crosses the same extension→browser→renderer IPC path; divide RTT by 2 for one-way.
  notifyStatus("Measuring local CPU IPC overhead…");
  let dynamicIpcMs = IPC_FALLBACK_MS;
  if (typeof warmupTabId === "number") {
    try {
      const t0 = performance.now();
      await chrome.scripting.executeScript({
        target: { tabId: warmupTabId },
        func: () => {},
      });
      dynamicIpcMs = Math.max(0, (performance.now() - t0) / 2);
    } catch (e) {
      console.warn("IPC measure failed, using fallback:", e);
      dynamicIpcMs = IPC_FALLBACK_MS;
    }
  }

  const adjustedLaunchTime = Math.round(targetEpochMs - oneWayLatency - dynamicIpcMs);
  await mergeRunState({ adjustedLaunchTime });

  notifyStatus(
    `Avg RTT: ${avgLatency.toFixed(1)} ms (≈ one-way ${(oneWayLatency).toFixed(1)} ms) + IPC ${dynamicIpcMs.toFixed(1)} ms. Adjusted launch (UTC): ${new Date(adjustedLaunchTime).toISOString()}. Final countdown…`,
  );

  const now = Date.now();
  if (adjustedLaunchTime <= now) {
    notifyStatus("Adjusted launch time already passed — navigating now.");
    navigateToTarget(targetUrl, warmupTabId, warmupWindowId, warmupWindowState, state);
    await finalizeRunSuccess(`Opened at adjusted time (avg latency ${avgLatency.toFixed(1)} ms).`);
    return;
  }

  const msUntilLaunch = adjustedLaunchTime - now;

  // Socket heartbeat: prefer warming sockets from inside the warm tab's network partition.
  // If injection fails (site restrictions / tab not ready), fall back to the service-worker heartbeat.
  let keepSocketHot = true;
  let usingInjectedHeartbeat = false;
  if (typeof warmupTabId === "number") {
    try {
      const cutoffMs = Math.max(0, msUntilLaunch - HEARTBEAT_CUTOFF_MS);
      await chrome.scripting.executeScript({
        target: { tabId: warmupTabId },
        func: (url, method, cutoffMs, intervalMs) => {
          // Runs inside the warmup tab (main-frame partition).
          const stopAt = Date.now() + cutoffMs;
          // Clear any previous run if present.
          try {
            if (globalThis.__pageConnectHeartbeatTimer) clearInterval(globalThis.__pageConnectHeartbeatTimer);
          } catch {}
          globalThis.__pageConnectHeartbeatTimer = setInterval(() => {
            if (Date.now() > stopAt) {
              clearInterval(globalThis.__pageConnectHeartbeatTimer);
              globalThis.__pageConnectHeartbeatTimer = null;
              return;
            }
            fetch(url, { method, cache: "no-store", priority: "high" }).catch(() => {});
          }, intervalMs);
        },
        args: [shop ? pingUrl : targetOrigin, shop ? "GET" : "HEAD", cutoffMs, HEARTBEAT_MS],
      });
      usingInjectedHeartbeat = true;
      notifyStatus("Socket heartbeat transferred to renderer process partition.");
    } catch (e) {
      console.warn("Tab injection failed, falling back to SW heartbeat:", e);
    }
  }

  if (!usingInjectedHeartbeat) {
    const heartbeatStopAt = adjustedLaunchTime - HEARTBEAT_CUTOFF_MS;
    void (async () => {
      while (keepSocketHot && !run.cancel) {
        const t = Date.now();
        if (t >= heartbeatStopAt) break;
        await delay(Math.min(HEARTBEAT_MS, Math.max(0, heartbeatStopAt - t)), run);
        if (!keepSocketHot || run.cancel) break;
        if (Date.now() >= heartbeatStopAt) break;
        fetch(shop ? pingUrl : targetOrigin, { method: shop ? "GET" : "HEAD", cache: "no-store", priority: "high" }).catch(() => {});
      }
    })();
  }

  if (msUntilLaunch > LONG_WAIT_MS) {
    keepSocketHot = false;
    const when = adjustedLaunchTime - PRE_LAUNCH_LEAD_MS;
    if (when <= Date.now()) {
      await waitUntilEpoch(adjustedLaunchTime, run);
      if (run.cancel) return;
      navigateToTarget(targetUrl, warmupTabId, warmupWindowId, warmupWindowState, state);
      await finalizeRunSuccess(`Opened at adjusted time (avg latency ${avgLatency.toFixed(1)} ms).`);
      return;
    }
    await chrome.alarms.create(ALARM_PRE_LAUNCH, { when });
    notifyStatus("Long final wait — scheduled wake-up before launch. Service worker may sleep.");
    session = null;
    return;
  }

  await waitUntilEpoch(adjustedLaunchTime, run);
  keepSocketHot = false;
  if (run.cancel) return;

  navigateToTarget(targetUrl, warmupTabId, warmupWindowId, warmupWindowState, state);
  await finalizeRunSuccess(`Opened at adjusted time (avg latency ${avgLatency.toFixed(1)} ms).`);
}

/**
 * Wait until T−60s, then run latency + launch logic.
 * @param {{ cancel: boolean }} run
 * @param {{ targetUrl: string, targetEpochMs: number }} job
 */
async function waitT60AndContinue(run, job) {
  lockPowerAwake();
  const { targetEpochMs, targetUrl } = job;
  const oneMinuteBefore = targetEpochMs - 60_000;

  notifyStatus(
    `Approaching latency window (${new Date(oneMinuteBefore).toISOString()} UTC)… ~${Math.max(0, Math.round((oneMinuteBefore - Date.now()) / 1000))}s`,
  );
  await waitUntilEpoch(oneMinuteBefore, run);
  if (run.cancel) return;

  const st = await readRunState();
  if (!st) return;

  await executeFromT60(run, { ...st, targetUrl, targetEpochMs });
}

/** @typedef {import("./shared.js").NotifyContact} NotifyContact */

/**
 * Start watching the launched tab. Stored so it survives the worker sleeping; `tabs.onUpdated`
 * wakes the worker on each navigation.
 * @param {number} tabId
 * @param {string} targetUrl
 * @param {NotifyContact | null | undefined} notify
 */
async function startMonitor(tabId, targetUrl, notify) {
  // Runs without a contact too: a check on the launched page still gets a desktop alert.
  await chrome.storage.local.set({
    [MONITOR_KEY]: { tabId, targetUrl, notify: hasContact(notify) ? notify : null, sent: {}, until: Date.now() + MONITOR_MS },
  });
}

/**
 * Runs inside the page (must be self-contained). Polls for a few seconds because bot checks and
 * waiting rooms often render after load. Returns "verify" (human check or sign-in needed),
 * "queue" (waiting room), "arrived" (product / cart / checkout page) or null.
 * @param {string} targetUrl
 * @param {typeof PAGE_SIGNALS} signals
 */
async function classifyPage(targetUrl, signals) {
  const CHALLENGE_SELECTORS = signals.challengeSelectors;
  const CHALLENGE_TEXT = new RegExp(signals.challengeText, "i");
  const QUEUE_TEXT = new RegExp(signals.queueText, "i");
  const SIGN_IN_PATH = new RegExp(signals.signInPath, "i");
  const PRODUCT_PATH = /\/(p|ip|dp|product|products|site)\/|\/gp\/product\/|\/(cart|checkout|basket)\b/i;
  const BUY_TEXT = /^\s*(add to (cart|bag)|buy now|pre-?order( now)?|ship it)\s*$/i;

  const visible = (el) => !!el && el.getClientRects().length > 0;
  const classify = () => {
    const title = document.title || "";
    const head = (document.body?.innerText || "").slice(0, 600);
    if (CHALLENGE_SELECTORS.some((s) => visible(document.querySelector(s))) || CHALLENGE_TEXT.test(title) || CHALLENGE_TEXT.test(head)) {
      return "verify";
    }
    if (/queue-it\.net$/i.test(location.hostname) || QUEUE_TEXT.test(title) || QUEUE_TEXT.test(head)) return "queue";
    if (SIGN_IN_PATH.test(location.pathname) || [...document.querySelectorAll('input[type="password"]')].some(visible)) {
      return "verify";
    }
    const target = new URL(targetUrl);
    const trim = (p) => p.replace(/\/+$/, "");
    const onTarget =
      trim(target.pathname) !== "" &&
      location.hostname.replace(/^www\./, "") === target.hostname.replace(/^www\./, "") &&
      trim(location.pathname) === trim(target.pathname);
    const buyButton = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')].some(
      (b) => visible(b) && BUY_TEXT.test(b.textContent || b.value || ""),
    );
    if (onTarget || buyButton || PRODUCT_PATH.test(location.pathname)) return "arrived";
    return null;
  };

  let result = null;
  for (let i = 0; i < 12; i++) {
    result = classify();
    if (result === "verify" || result === "queue") return result;
    await new Promise((r) => setTimeout(r, 500));
  }
  return result;
}

/** @param {string} url */
function siteName(url) {
  return retailerFor(url)?.name ?? new URL(url).hostname.replace(/^www\./, "");
}

/** @type {Record<string, ReturnType<typeof setTimeout>>} */
const recheckTimers = {};
/** One pending re-check per purpose; a newer one replaces it. Lost if the worker sleeps (navigation wakes it). */
function scheduleRecheck(key, tabId, fn) {
  clearTimeout(recheckTimers[key]);
  recheckTimers[key] = setTimeout(() => void fn(), ATTENTION_REPEAT_MS);
}

/**
 * Retail drop: wait for T−5 min (or schedule an alarm for it), then open the store.
 * @param {{ cancel: boolean }} run
 * @param {import("./retailers.js").Retailer} shop
 * @param {{ targetUrl: string, targetEpochMs: number, notify?: NotifyContact | null }} job
 * @returns {Promise<boolean>} true if an alarm will continue the run (stop here)
 */
async function prepareRetail(run, shop, job) {
  const prepAt = job.targetEpochMs - RETAIL_PREP_MS;
  if (prepAt - Date.now() > LONG_WAIT_MS) {
    await chrome.alarms.create(ALARM_PREP, { when: prepAt });
    notifyStatus(
      `${shop.name} drop: the store opens in a tab at T−5 min (${new Date(prepAt).toLocaleTimeString()}) so you can sign in and clear any check before launch. The service worker may sleep until then.`,
    );
    return true;
  }
  if (prepAt > Date.now()) {
    notifyStatus(`${shop.name} drop: opening the store at T−5 min (${new Date(prepAt).toLocaleTimeString()})…`);
    await waitUntilEpoch(prepAt, run);
    if (run.cancel) return false;
  }
  await openPrepTab(shop, job);
  return false;
}

/**
 * Open the store's homepage for sign-in and checks; it becomes the launch tab.
 * @param {import("./retailers.js").Retailer} shop
 * @param {{ targetUrl: string, notify?: NotifyContact | null }} job
 */
async function openPrepTab(shop, job) {
  lockPowerAwake();
  let tab;
  try {
    tab = await chrome.tabs.create({ url: `${new URL(job.targetUrl).origin}/`, active: true });
  } catch (e) {
    notifyStatus(`Couldn't open ${shop.name} early (${e instanceof Error ? e.message : e}); a warm tab opens at T−60s instead.`);
    return;
  }
  if (tab.id == null) return;
  chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  let windowState = null;
  try {
    windowState = (await chrome.windows.get(tab.windowId)).state ?? null;
  } catch {
    /* ignore */
  }
  await mergeRunState({ prepTabId: tab.id, warmupTabId: tab.id, warmupWindowId: tab.windowId ?? null, warmupWindowState: windowState });
  notifyStatus(`Opened ${shop.name}. Sign in and complete any check in that tab now; it won't be reloaded before launch.`);
  void demandAttention(tab.id, `${shop.name} drop in 5 minutes`, "Sign in and complete any check in this tab now, so nothing slows you down at launch.");
  if (job.notify) void sendNotify(job.notify, "verify", job.targetUrl);
}

let prepAlertAt = 0;

/**
 * The prep tab loaded a page: if it's a human check or sign-in, bring it to the user (again each
 * minute until it's done). Runs until launch, when the launched-tab monitor takes over.
 * @param {number} tabId
 */
async function checkPrepTab(tabId) {
  const st = await readRunState();
  if (!st || st.prepTabId !== tabId || Date.now() >= st.targetEpochMs) return;
  let kind = null;
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: classifyPage, args: [st.targetUrl, PAGE_SIGNALS] });
    kind = res?.result ?? null;
  } catch {
    return;
  }
  if (kind !== "verify") {
    if (prepAlertAt) void clearAttention(tabId);
    prepAlertAt = 0;
    return;
  }
  if (Date.now() - prepAlertAt > ATTENTION_REPEAT_MS) {
    prepAlertAt = Date.now();
    notifyStatus(`${siteName(st.targetUrl)} is asking you to sign in or complete a check in the launch tab — do it now, before the drop.`);
    void demandAttention(tabId, `${siteName(st.targetUrl)} needs you before the drop`, "Complete the sign-in or check in this tab now.");
  }
  scheduleRecheck("prep", tabId, () => checkPrepTab(tabId));
}

let monitorBusy = false;
let monitorAgain = false;

/**
 * Classify the monitored tab's current page and send any alerts not sent yet.
 * Serialized: a navigation that lands mid-check queues one more pass.
 * @param {number} tabId
 */
async function checkMonitoredTab(tabId) {
  if (monitorBusy) {
    monitorAgain = true;
    return;
  }
  monitorBusy = true;
  try {
    do {
      monitorAgain = false;
      const mon = (await chrome.storage.local.get(MONITOR_KEY))[MONITOR_KEY];
      if (!mon || mon.tabId !== tabId) return;
      if (Date.now() > mon.until) {
        await chrome.storage.local.remove(MONITOR_KEY);
        return;
      }
      const sent = { ...mon.sent };
      if (!sent.connected) {
        sent.connected = Date.now();
        if (mon.notify) void sendNotify(mon.notify, "connected", mon.targetUrl);
      }

      let kind = null;
      try {
        const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: classifyPage, args: [mon.targetUrl, PAGE_SIGNALS] });
        kind = res?.result ?? null;
      } catch (e) {
        console.warn("classifyPage failed:", e);
      }

      // A stock watch on this tab (add to cart after launch) does its own check alerts.
      const watched = (await getWatch())?.tabId === tabId;
      if (kind === "verify" && !watched) {
        const now = Date.now();
        if (!sent.attention || now - sent.attention > ATTENTION_REPEAT_MS) {
          sent.attention = now;
          void demandAttention(tabId, `${siteName(mon.targetUrl)} needs you`, "Sign in or complete the check in this tab.");
        }
        const count = sent.verifyCount ?? 0;
        if (mon.notify && count < REMOTE_VERIFY_MAX && (!sent.verify || now - sent.verify > REMOTE_VERIFY_MS)) {
          sent.verify = now;
          sent.verifyCount = count + 1;
          void sendNotify(mon.notify, "verify", mon.targetUrl);
        }
        // Look again in a minute (without reloading) to repeat the alert while it's outstanding.
        scheduleRecheck("monitor", tabId, () => checkMonitoredTab(tabId));
      } else if (sent.attention) {
        sent.attention = 0;
        sent.verifyCount = 0;
        void clearAttention(tabId);
      }
      if (kind === "arrived" && !sent.arrived) {
        if (mon.notify) void sendNotify(mon.notify, "arrived", mon.targetUrl);
        await chrome.storage.local.remove(MONITOR_KEY);
        return;
      }
      await chrome.storage.local.set({ [MONITOR_KEY]: { ...mon, sent } });
    } while (monitorAgain);
  } finally {
    monitorBusy = false;
  }
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  // Full loads report "complete"; single-page-app route changes only report a new URL.
  if (info.status !== "complete" && !info.url) return;
  void checkMonitoredTab(tabId);
  void runCheck(tabId);
  void checkPrepTab(tabId);
});

chrome.notifications?.onClicked.addListener((id) => {
  if (!handleAttentionClick(id)) void handleNotificationClick(id);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCH_ALARM) {
    void handleWatchAlarm();
    return;
  }
  if (alarm.name !== ALARM_PRE_LATENCY && alarm.name !== ALARM_PRE_LAUNCH && alarm.name !== ALARM_PREP) return;

  void (async () => {
    const run = { cancel: false };
    session = run;

    try {
      const st = await readRunState();
      if (!st || typeof st.targetUrl !== "string" || typeof st.targetEpochMs !== "number") {
        await clearOurAlarms();
        await chrome.storage.local.set({ [ACTIVE_KEY]: false });
        return;
      }

      if (alarm.name === ALARM_PREP || alarm.name === ALARM_PRE_LATENCY) {
        await chrome.alarms.clear(alarm.name);
        if (alarm.name === ALARM_PREP) {
          const shop = retailerFor(st.targetUrl);
          if (shop) await openPrepTab(shop, st);
          // Back to the usual plan: wake at T−3 min for the latency window.
          const when = st.targetEpochMs - T180_MS_BEFORE_TARGET;
          if (when - Date.now() > 10_000) {
            await chrome.alarms.create(ALARM_PRE_LATENCY, { when });
            return;
          }
        }
        await waitT60AndContinue(run, st);
        if (run.cancel) {
          const rs = await readRunState();
          if (typeof rs?.warmupTabId === "number") {
            try {
              await chrome.tabs.remove(rs.warmupTabId);
            } catch {
              /* ignore */
            }
          }
          await chrome.storage.local.set({ [ACTIVE_KEY]: false });
          await chrome.storage.local.remove(RUN_KEY);
          notifyStatus("Cancelled.");
        }
      } else {
        await chrome.alarms.clear(ALARM_PRE_LAUNCH);
        const adjusted = st.adjustedLaunchTime;
        if (adjusted == null || typeof adjusted !== "number") {
          await finalizeRunFailure("Internal error: missing adjusted launch time.");
          return;
        }
        await waitUntilEpoch(adjusted, run);
        if (run.cancel) {
          const rs = await readRunState();
          if (typeof rs?.warmupTabId === "number") {
            try {
              await chrome.tabs.remove(rs.warmupTabId);
            } catch {
              /* ignore */
            }
          }
          await chrome.storage.local.set({ [ACTIVE_KEY]: false });
          await chrome.storage.local.remove(RUN_KEY);
          notifyStatus("Cancelled.");
          return;
        }
        navigateToTarget(st.targetUrl, st.warmupTabId, st.warmupWindowId, st.warmupWindowState, st);
        await finalizeRunSuccess("Opened at adjusted time.");
      }
    } catch (e) {
      console.error("onAlarm error:", e);
      await finalizeRunFailure(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      session = null;
    }
  })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const mon = (await chrome.storage.local.get(MONITOR_KEY))[MONITOR_KEY];
    if (mon?.tabId === tabId) await chrome.storage.local.remove(MONITOR_KEY);
    await handleWatchTabRemoved(tabId);
    const st = await readRunState();
    if (st && st.warmupTabId === tabId && (await isOrchestrationActive())) {
      await mergeRunState({ warmupTabId: null });
      notifyStatus("Warmup tab was closed — launch will use a new tab if needed.");
    }
  })();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === MSG.PING) {
    void handlePing().then((r) => sendResponse(r));
    return true;
  }

  if (msg.type === MSG.CANCEL) {
    void (async () => {
      releasePowerAwake();
      clearSession();
      await clearOurAlarms();
      await stopWatch();
      const st = await readRunState();
      if (st?.warmupTabId != null) {
        try {
          // Best-effort: stop any injected heartbeat before closing the warmup tab.
          try {
            await chrome.scripting.executeScript({
              target: { tabId: st.warmupTabId },
              func: () => {
                try {
                  if (globalThis.__pageConnectHeartbeatTimer) clearInterval(globalThis.__pageConnectHeartbeatTimer);
                  globalThis.__pageConnectHeartbeatTimer = null;
                } catch {}
              },
            });
          } catch {
            /* ignore */
          }
          await chrome.tabs.remove(st.warmupTabId);
        } catch {
          /* ignore */
        }
      }
      await chrome.storage.local.remove(RUN_KEY);
      await chrome.storage.local.set({ [ACTIVE_KEY]: false });
    })();
    sendResponse?.({ ok: true });
    return;
  }

  if (msg.type === MSG.START) {
    const payload = msg.payload;
    const watchNow = payload?.mode === "watch";
    if (!payload || typeof payload.targetUrl !== "string" || (!watchNow && typeof payload.targetEpochMs !== "number")) {
      sendResponse?.({ ok: false, error: "Invalid payload" });
      return;
    }

    // "Watch" mode: no schedule — start checking the product page now.
    if (watchNow) {
      void (async () => {
        clearSession();
        await clearOurAlarms();
        await stopWatch();
        await chrome.storage.local.remove([RUN_KEY, MONITOR_KEY]);
        await chrome.storage.local.set({ [ACTIVE_KEY]: false });
        sendResponse(
          await startWatch({
            url: payload.targetUrl,
            autoCart: payload.autoCart !== false,
            intervalSec: payload.intervalSec,
            notify: payload.notify,
          }),
        );
      })();
      return true;
    }

    void (async () => {
      clearSession();
      await clearOurAlarms();
      await stopWatch();

      const run = { cancel: false };
      session = run;

      const { targetUrl, targetEpochMs } = payload;
      const notify = hasContact(payload.notify) ? payload.notify : null;
      // Timed launch on a retail site with "add to cart" ticked: watch the tab once it opens.
      const watch = payload.autoCart === true && retailerFor(targetUrl) ? { intervalSec: payload.intervalSec } : null;
      const oneMinuteBefore = targetEpochMs - 60_000;
      const now = Date.now();

      try {
        await chrome.storage.local.set({
          [ACTIVE_KEY]: true,
          [RUN_KEY]: {
            targetUrl,
            targetEpochMs,
            warmupTabId: null,
            warmupWindowId: null,
            warmupWindowState: null,
            adjustedLaunchTime: null,
            notify,
            watch,
          },
        });
        // A new run replaces any previous launch's watcher.
        await chrome.storage.local.remove(MONITOR_KEY);

        if (oneMinuteBefore <= now) {
          await finalizeRunFailure("Missed the 1-minute pre-window. Pick a later target time.");
          return;
        }

        // Retail drop: open the store at T−5 min for sign-in and checks first.
        const shop = retailerFor(targetUrl);
        if (shop && (await prepareRetail(run, shop, { targetUrl, targetEpochMs, notify }))) {
          session = null;
          return;
        }
        if (run.cancel) return;

        const msUntilT60 = oneMinuteBefore - Date.now();

        if (msUntilT60 > LONG_WAIT_MS) {
          const when = targetEpochMs - T180_MS_BEFORE_TARGET;
          if (when <= Date.now()) {
            await waitT60AndContinue(run, { targetUrl, targetEpochMs });
          } else {
            await chrome.alarms.create(ALARM_PRE_LATENCY, { when });
            notifyStatus(
              `Pre-wait is long — scheduled wake-up at T−3m (${new Date(when).toISOString()} UTC). The service worker may sleep until then.`,
            );
            session = null;
          }
        } else {
          notifyStatus(
            `Waiting for 1-minute mark (${new Date(oneMinuteBefore).toISOString()} UTC)… ~${Math.round(msUntilT60 / 1000)}s`,
          );
          await waitUntilEpoch(oneMinuteBefore, run);
          if (run.cancel) {
            const rs0 = await readRunState();
            if (rs0?.warmupTabId != null) {
              try {
                await chrome.tabs.remove(rs0.warmupTabId);
              } catch {
                /* ignore */
              }
            }
            await chrome.storage.local.set({ [ACTIVE_KEY]: false });
            await chrome.storage.local.remove(RUN_KEY);
            notifyStatus("Cancelled.");
            return;
          }
          const st = await readRunState();
          if (!st) return;
          await executeFromT60(run, { ...st, targetUrl, targetEpochMs });
        }

        if (run.cancel) {
          const rs = await readRunState();
          if (rs?.warmupTabId != null) {
            try {
              await chrome.tabs.remove(rs.warmupTabId);
            } catch {
              /* ignore */
            }
          }
          await chrome.storage.local.set({ [ACTIVE_KEY]: false });
          await chrome.storage.local.remove(RUN_KEY);
          notifyStatus("Cancelled.");
        }
      } catch (e) {
        console.error("PAGE_CONNECT_START error:", e);
        await finalizeRunFailure(`Error: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        session = null;
      }
    })();

    sendResponse?.({ ok: true });
  }
});
