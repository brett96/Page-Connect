# Page Connect (Chrome Extension, Manifest V3)

**Page Connect** is a Manifest V3 Chrome extension that opens any target URL at a precise user-selected time, adjusted by measured network latency so the navigation happens as close as possible to the intended instant.

It’s built around the realities of MV3 service workers (they can sleep) and the fact that creating a brand-new tab at the last millisecond adds unpredictable overhead.

## What it does

- **You choose**:
  - A **Target URL** (any `http://` or `https://` URL)
  - A **Target date/time** (with **seconds** support) + a **timezone** (defaults to Pacific)
- **Page Connect**:
  - Wakes up early (alarms) and then works toward **T−60s**
  - Opens a **warmup tab** on the same origin (lightweight 404 HTML route)
  - Measures network latency with a primer ping + 4 timed pings
  - Calculates an **Adjusted Launch Time** that targets **server-arrival** time (RTT/2) and accounts for local IPC delay
  - Keeps sockets warm via an **in-tab heartbeat** (same network partition as the final navigation)
  - At launch, dispatches tab navigation + window focus **without blocking awaits**

## How it works (high-level)

### Timing + MV3 “sleep” protection
Manifest V3 background code runs in a **service worker**, which Chrome may suspend while waiting.

To survive long waits, Page Connect uses the **Alarms API**:
- For long pre-waits, it schedules a wake-up at **T−3 minutes** (`pageConnectAlarmPreLatency`) so OS-level timer throttling won’t cause you to miss the T−60 latency window.
- For long final waits, it schedules a wake-up **15 seconds** before the adjusted launch time (`pageConnectAlarmPreLaunch`) so a cold-booted service worker has runway to wake, read state, and start the final high-precision wait.

### Latency measurement (“pings”)
Latency checks are done with `fetch()`:
- Uses **`HEAD`** first (headers only) to avoid measuring full HTML rendering/body transfer.
- Falls back to **`GET`** if `HEAD` is blocked by the server.
- A **primer ping** warms TCP/TLS/keep-alive and is **discarded**.
- Then **4 measured pings**, 10 seconds apart, are averaged.
- Any failed ping contributes **0ms** for that sample (so the flow still completes).

**Important math note:** the measured value is **RTT** (round-trip). To target “request arrives at server at target time”, Page Connect approximates **one-way latency** as \(RTT/2\).

### Local IPC overhead measurement
Right after latency measurement, Page Connect measures local extension→renderer IPC cost by timing an empty:
- `chrome.scripting.executeScript({ func: () => {} })`

It uses half of that round-trip as the one-way IPC estimate and subtracts it in the launch math.

### Warm tab navigation (reduces launch jitter)
Opening a brand new tab at the exact millisecond can add 50–200ms of overhead.

Instead, around **T−60s**, Page Connect opens a background tab to:
- `{origin}/_page_connect_warmup_<timestamp>`

This keeps the tab on the **same origin** as the final destination, helping Chrome allocate the “right kind” of renderer process and warm connection pools before the final navigation.

At launch time, it does:
- `chrome.tabs.update(warmupTabId, { url: targetUrl, active: true, muted: false })`
- In parallel, `chrome.windows.update(windowId, { focused: true, drawAttention: true, state: "normal" })`

If the warm tab was closed or fails, it falls back to `chrome.tabs.create`.

### In-tab socket heartbeat (network partition correctness)
Modern Chromium uses network partitioning; sockets opened by the service worker may not be reusable by a tab’s main frame.

To keep the **tab’s** connection pool hot, Page Connect injects a small heartbeat into the warmup tab:
- Every ~8 seconds it does `fetch(origin, { method: "HEAD", cache: "no-store", priority: "high" })`
- Stops ~2 seconds before launch

If injection is blocked, it falls back to a service-worker heartbeat.

### Orphaned UI protection
If Chrome crashes or the extension reloads, a stored “active” flag can become stale.

The popup sends a **PING** message on load. If the background is not actually running (no in-memory session and no alarms), the extension automatically resets the stored active state so the UI doesn’t get stuck.

## Project structure

- `manifest.json` — MV3 manifest (service worker, permissions, host permissions)
- `background.js` — the scheduling engine (alarms, pings, adjusted launch, warm tab)
- `popup.html` / `popup.css` — dark-mode UI
- `popup.js` — input validation, timezone → epoch conversion, messaging, status UI

## Permissions (why they’re needed)

- **`storage`**: save your configuration + persisted run state between service worker wake-ups
- **`tabs`**: create/update a tab for warmup + launch navigation
- **`alarms`**: schedule long waits reliably in MV3 (wake the service worker)
- **`windows`**: bring the target Chrome window to the foreground at launch
- **`power`**: request “keep awake” during the critical countdown windows to avoid OS sleep/throttling
- **`scripting`**: measure IPC overhead and inject the in-tab heartbeat
- **Host permissions: `<all_urls>`**: allow `fetch()` latency checks to any target origin

## Install in Chrome (Unpacked / Developer Mode)

1. Open **Chrome** and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this folder:
   - `C:\Users\brtom\Documents\Page Connect`
5. Confirm any permission prompts (the extension requests access to run on all sites so it can measure latency to any URL)

## Use it

1. Click the **Page Connect** extension icon to open the popup
2. Enter:
   - **Target URL** (must be `http(s)`)
   - **Target date/time** (seconds supported)
   - **Timezone** (default Pacific)
3. Click **Start**
4. Keep Chrome running until it completes.
5. At launch time, the warm tab will navigate to your target URL and Chrome should be focused.

## Notes / limitations

- **Absolute millisecond precision is not guaranteed** in a browser:
  - OS scheduling, CPU load, power-saving, network variability, and Chrome throttling can still introduce jitter.
- **Local system clock skew matters**:
  - The schedule is based on `Date.now()`. Before important drops, manually sync your OS clock (Windows “Sync now”).
- **Some sites may block or rate-limit HEAD/GET**; Page Connect will fall back and/or treat failures as 0ms samples.
- **If you close the warmup tab**, Page Connect will fall back to opening the target in a new tab at launch.

## Troubleshooting

- **Popup says “in progress” forever**:
  - Re-open the popup; it pings the background and should self-correct.
  - Or press **Cancel**.
- **Nothing happens at the target time**:
  - Ensure you reloaded the extension after changes (`chrome://extensions` → reload).
  - Ensure Chrome is running and not force-quit by the OS.
- **Window didn’t come to the front**:
  - Some OS focus policies can limit programmatic focus changes; Page Connect still activates the tab in the window it can access.

