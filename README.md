# Page Connect (Chrome Extension, Manifest V3)

**Page Connect** is a Manifest V3 Chrome extension that opens any target URL at a precise user-selected time, adjusted by measured network latency so the navigation happens as close as possible to the intended instant.

It’s built around the realities of MV3 service workers (they can sleep) and the fact that creating a brand-new tab at the last millisecond adds unpredictable overhead.

## What it does

- **You choose**:
  - A **Target URL** (any `http://` or `https://` URL)
  - A **Target date/time** (with **seconds** support) + a **timezone** (defaults to Pacific)
- **Page Connect**:
  - Waits until about **1 minute before** the target time
  - Measures latency to the target origin via a small burst of fetch requests
  - Computes an **Adjusted Launch Time** = `TargetTime − avgLatency`
  - Navigates a pre-warmed tab to the target URL at the adjusted time

## How it works (high-level)

### Timing + MV3 “sleep” protection
Manifest V3 background code runs in a **service worker**, which Chrome may suspend while waiting.

To survive long waits, Page Connect uses the **Alarms API**:
- For long pre-waits, it schedules an alarm at **T−70 seconds** (`pageConnectAlarmPreLatency`) and persists the job into `chrome.storage.local`.
- For long final waits, it schedules an alarm **15 seconds** before the adjusted launch time (`pageConnectAlarmPreLaunch`) to give a cold-booted service worker enough runway to wake, read state, and start the final high-precision wait.

### Latency measurement (“pings”)
Latency checks are done with `fetch()`:
- Uses **`HEAD`** first (headers only) to avoid measuring full HTML rendering/body transfer.
- Falls back to **`GET`** if `HEAD` is blocked by the server.
- A **primer ping** warms TCP/TLS/keep-alive and is **discarded**.
- Then **4 measured pings**, 10 seconds apart, are averaged.
- Any failed ping contributes **0ms** for that sample (so the flow still completes).

### Warm tab navigation (reduces launch jitter)
Opening a brand new tab at the exact millisecond can add 50–200ms of overhead.

Instead, around **T−60s**, Page Connect opens a background tab to:
- `{origin}/robots.txt`

This keeps the tab on the **same origin** as the final destination, helping Chrome allocate the “right kind” of renderer process and warm connection pools before the final navigation.

At launch time, it does:
- `chrome.tabs.update(warmupTabId, { url: targetUrl, active: true })`
- Then focuses the window via `chrome.windows.update(windowId, { focused: true })`

If the warm tab was closed or fails, it falls back to `chrome.tabs.create`.

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

