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
async function pingOnce(url) {
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
async function createWarmupTab(run, targetUrl) {
  if (run.cancel) return null;
  try {
    const targetOrigin = new URL(targetUrl).origin;
    // Use a unique fake path so most servers return a lightweight 404 HTML page.
    // This lets us inject an in-tab heartbeat that warms the *tab's* network partition.
    const warmupUrl = `${targetOrigin}/_page_connect_warmup_${Date.now()}`;
    const tab = await chrome.tabs.create({ url: warmupUrl, active: false, muted: true });
    if (tab.id == null) return null;
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
 */
function navigateToTarget(targetUrl, warmupTabId, warmupWindowId, warmupWindowState) {
  if (typeof warmupTabId === "number") {
    chrome.tabs.update(warmupTabId, { url: targetUrl, active: true, muted: false }).catch(() => {});
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
    })
    .catch(() => {});
}

/**
 * From T−60s: warmup tab, latency suite, then either schedule pre-launch alarm or launch inline.
 * @param {{ cancel: boolean }} run
 * @param {{ targetUrl: string, targetEpochMs: number, warmupTabId?: number | null }} state
 */
async function executeFromT60(run, state) {
  lockPowerAwake();
  const { targetUrl, targetEpochMs } = state;
  const targetOrigin = new URL(targetUrl).origin;

  notifyStatus("Opening warmup tab on target origin (warm 404)…");
  const warm = await createWarmupTab(run, targetUrl);
  const warmupTabId = warm?.tabId ?? null;
  const warmupWindowId = warm?.windowId ?? null;
  const warmupWindowState = warm?.windowState ?? null;
  if (warmupTabId == null) {
    notifyStatus("Warmup tab unavailable — will open the target in a new tab at launch.");
  }

  if (run.cancel) return;

  notifyStatus("Starting latency checks at T−60s…");
  const avgLatency = await runLatencySuite(targetUrl, run);
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
    navigateToTarget(targetUrl, warmupTabId, warmupWindowId, warmupWindowState);
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
        func: (origin, cutoffMs, intervalMs) => {
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
            fetch(origin, { method: "HEAD", cache: "no-store", priority: "high" }).catch(() => {});
          }, intervalMs);
        },
        args: [targetOrigin, cutoffMs, HEARTBEAT_MS],
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
        fetch(targetOrigin, { method: "HEAD", cache: "no-store", priority: "high" }).catch(() => {});
      }
    })();
  }

  if (msUntilLaunch > LONG_WAIT_MS) {
    keepSocketHot = false;
    const when = adjustedLaunchTime - PRE_LAUNCH_LEAD_MS;
    if (when <= Date.now()) {
      await waitUntilEpoch(adjustedLaunchTime, run);
      if (run.cancel) return;
      navigateToTarget(targetUrl, warmupTabId, warmupWindowId, warmupWindowState);
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

  navigateToTarget(targetUrl, warmupTabId, warmupWindowId, warmupWindowState);
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
        navigateToTarget(st.targetUrl, st.warmupTabId, st.warmupWindowId, st.warmupWindowState);
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
      releasePowerAwake();
      clearSession();
      await clearOurAlarms();
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
          [RUN_KEY]: {
            targetUrl,
            targetEpochMs,
            warmupTabId: null,
            warmupWindowId: null,
            warmupWindowState: null,
            adjustedLaunchTime: null,
          },
        });

        if (oneMinuteBefore <= now) {
          await finalizeRunFailure("Missed the 1-minute pre-window. Pick a later target time.");
          return;
        }

        const msUntilT60 = oneMinuteBefore - now;

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
