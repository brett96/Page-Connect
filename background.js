/**
 * Service worker (Manifest V3) — Page Connect scheduling engine.
 *
 * Long waits use `chrome.alarms` so Chrome can suspend this worker without losing the schedule.
 * Latency pings use `HEAD` when possible (falls back to `GET`).
 * Launch uses a same-origin warmup tab (`{origin}/robots.txt`) + `chrome.tabs.update` so the renderer
 * matches the target site (avoids extension-page to web process swap at navigation).
 *
 * Phases (conceptual):
 * 1) Reach T−60s (alarm at T−70s if the pre-wait is long).
 * 2) Open same-origin warmup tab, primer ping (discarded), then 4 measured pings at T−60s … T−30s (10s spacing).
 * 3) Average RTT; failures count as 0 ms for that sample.
 * 4) AdjustedLaunchTime = TargetTime − averageLatencyMs.
 * 5) At AdjustedLaunchTime, `tabs.update` + focus window (or `tabs.create` + focus if warmup failed).
 */

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

/** Fires ~10s before T−60s so we can wake, then fine-wait to T−60s. */
const ALARM_PRE_LATENCY = "pageConnectAlarmPreLatency";
/** Fires well before adjusted launch so a cold service-worker boot still has time to spin. */
const ALARM_PRE_LAUNCH = "pageConnectAlarmPreLaunch";

/** If waiting longer than this until T−60s or until launch, delegate to `chrome.alarms`. */
const LONG_WAIT_MS = 120_000;
const T70_MS_BEFORE_TARGET = 70_000;
/** ~15s runway: SW cold start under load can exceed 1–3s; 2s was too tight. */
const PRE_LAUNCH_LEAD_MS = 15_000;

/** @type {{ cancel: boolean } | null} */
let session = null;

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
  await Promise.all([chrome.alarms.clear(ALARM_PRE_LATENCY), chrome.alarms.clear(ALARM_PRE_LAUNCH)]);
}

/**
 * True if this worker currently has an in-memory run, or Chrome has scheduled one of our alarms.
 */
async function isOrchestrationActive() {
  if (session && !session.cancel) return true;
  const alarms = await chrome.alarms.getAll();
  return alarms.some((a) => a.name === ALARM_PRE_LATENCY || a.name === ALARM_PRE_LAUNCH);
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
  return { isRunning: running };
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
      while (performance.now() < targetPerf) {
        if (run.cancel) return;
      }
      return;
    }
  }
}

/**
 * RTT sample: prefer `HEAD` (headers only). Some hosts reject HEAD — fall back to `GET`.
 * @param {string} url
 * @returns {Promise<number>}
 */
async function pingOnce(url) {
  const measure = async (method) => {
    const t0 = performance.now();
    const res = await fetch(url, {
      method,
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
    });
    const t1 = performance.now();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return Math.max(0, t1 - t0);
  };

  try {
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
async function runLatencySuite(targetUrl, run) {
  notifyStatus("Warming connection (primer ping, discarded)…");
  await pingOnce(targetUrl);
  if (run.cancel) return 0;

  const samples = [];
  for (let i = 0; i < 4; i++) {
    if (run.cancel) return samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;

    notifyStatus(`Pinging (${i + 1}/4)…`);
    samples.push(await pingOnce(targetUrl));

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
  await clearOurAlarms();
  await chrome.storage.local.remove(RUN_KEY);
  await chrome.storage.local.set({ [ACTIVE_KEY]: false });
  session = null;
  notifyDone(message, true);
}

async function finalizeRunFailure(message) {
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
 * Opens a background tab on the target origin (`/robots.txt`) so Chrome uses the same renderer
 * process class as the final URL (avoids extension-page → site process swap at `tabs.update`).
 * @param {{ cancel: boolean }} run
 * @param {string} targetUrl
 * @returns {Promise<number | null>} tab id or null
 */
async function createWarmupTab(run, targetUrl) {
  if (run.cancel) return null;
  try {
    const targetOrigin = new URL(targetUrl).origin;
    const warmupUrl = `${targetOrigin}/robots.txt`;
    const tab = await chrome.tabs.create({ url: warmupUrl, active: false });
    if (tab.id == null) return null;
    await mergeRunState({ warmupTabId: tab.id });
    return tab.id;
  } catch (e) {
    console.warn("Warmup tab create failed:", e);
    return null;
  }
}

/**
 * Navigate the warmup tab to the target, or open a new tab if warmup is missing.
 * @param {string} targetUrl
 * @param {number | null | undefined} warmupTabId
 */
async function navigateToTarget(targetUrl, warmupTabId) {
  if (typeof warmupTabId === "number") {
    try {
      const tab = await chrome.tabs.update(warmupTabId, { url: targetUrl, active: true });
      if (tab?.windowId != null) {
        await chrome.windows.update(tab.windowId, { focused: true });
      }
      return;
    } catch (e) {
      console.warn("tabs.update failed, falling back to tabs.create:", e);
    }
  }
  const newTab = await chrome.tabs.create({ url: targetUrl, active: true });
  if (newTab.windowId != null) {
    await chrome.windows.update(newTab.windowId, { focused: true });
  }
}

/**
 * From T−60s: warmup tab, latency suite, then either schedule pre-launch alarm or launch inline.
 * @param {{ cancel: boolean }} run
 * @param {{ targetUrl: string, targetEpochMs: number, warmupTabId?: number | null }} state
 */
async function executeFromT60(run, state) {
  const { targetUrl, targetEpochMs } = state;

  notifyStatus("Opening warmup tab on target origin (robots.txt)…");
  const warmupTabId = await createWarmupTab(run, targetUrl);
  if (warmupTabId == null) {
    notifyStatus("Warmup tab unavailable — will open the target in a new tab at launch.");
  }

  if (run.cancel) return;

  notifyStatus("Starting latency checks at T−60s…");
  const avgLatency = await runLatencySuite(targetUrl, run);
  if (run.cancel) return;

  const adjustedLaunchTime = Math.round(targetEpochMs - avgLatency);
  await mergeRunState({ adjustedLaunchTime });

  notifyStatus(
    `Average latency: ${avgLatency.toFixed(1)} ms. Adjusted launch (UTC): ${new Date(adjustedLaunchTime).toISOString()}. Final countdown…`,
  );

  const now = Date.now();
  if (adjustedLaunchTime <= now) {
    notifyStatus("Adjusted launch time already passed — navigating now.");
    await navigateToTarget(targetUrl, warmupTabId ?? (await readRunState())?.warmupTabId);
    await finalizeRunSuccess(`Opened at adjusted time (avg latency ${avgLatency.toFixed(1)} ms).`);
    return;
  }

  const msUntilLaunch = adjustedLaunchTime - now;
  if (msUntilLaunch > LONG_WAIT_MS) {
    const when = adjustedLaunchTime - PRE_LAUNCH_LEAD_MS;
    if (when <= Date.now()) {
      await waitUntilEpoch(adjustedLaunchTime, run);
      if (run.cancel) return;
      const rs = await readRunState();
      await navigateToTarget(targetUrl, rs?.warmupTabId);
      await finalizeRunSuccess(`Opened at adjusted time (avg latency ${avgLatency.toFixed(1)} ms).`);
      return;
    }
    await chrome.alarms.create(ALARM_PRE_LAUNCH, { when });
    notifyStatus("Long final wait — scheduled wake-up before launch. Service worker may sleep.");
    session = null;
    return;
  }

  await waitUntilEpoch(adjustedLaunchTime, run);
  if (run.cancel) return;

  const rs = await readRunState();
  await navigateToTarget(targetUrl, rs?.warmupTabId);
  await finalizeRunSuccess(`Opened at adjusted time (avg latency ${avgLatency.toFixed(1)} ms).`);
}

/**
 * Wait until T−60s, then run latency + launch logic.
 * @param {{ cancel: boolean }} run
 * @param {{ targetUrl: string, targetEpochMs: number }} job
 */
async function waitT60AndContinue(run, job) {
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

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM_PRE_LATENCY && alarm.name !== ALARM_PRE_LAUNCH) return;

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

        if (alarm.name === ALARM_PRE_LATENCY) {
        await chrome.alarms.clear(ALARM_PRE_LATENCY);
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
        const latest = await readRunState();
        await navigateToTarget(st.targetUrl, latest?.warmupTabId);
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
      clearSession();
      await clearOurAlarms();
      const st = await readRunState();
      if (st?.warmupTabId != null) {
        try {
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
    if (!payload || typeof payload.targetUrl !== "string" || typeof payload.targetEpochMs !== "number") {
      sendResponse?.({ ok: false, error: "Invalid payload" });
      return;
    }

    void (async () => {
      clearSession();
      await clearOurAlarms();

      const run = { cancel: false };
      session = run;

      const { targetUrl, targetEpochMs } = payload;
      const oneMinuteBefore = targetEpochMs - 60_000;
      const now = Date.now();

      try {
        await chrome.storage.local.set({
          [ACTIVE_KEY]: true,
          [RUN_KEY]: { targetUrl, targetEpochMs, warmupTabId: null, adjustedLaunchTime: null },
        });

        if (oneMinuteBefore <= now) {
          await finalizeRunFailure("Missed the 1-minute pre-window. Pick a later target time.");
          return;
        }

        const msUntilT60 = oneMinuteBefore - now;

        if (msUntilT60 > LONG_WAIT_MS) {
          const when = targetEpochMs - T70_MS_BEFORE_TARGET;
          if (when <= Date.now()) {
            await waitT60AndContinue(run, { targetUrl, targetEpochMs });
          } else {
            await chrome.alarms.create(ALARM_PRE_LATENCY, { when });
            notifyStatus(
              `Pre-wait is long — scheduled wake-up at T−70s (${new Date(when).toISOString()} UTC). The service worker may sleep until then.`,
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
