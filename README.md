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

### Email / SMS alerts (optional)
Enter an email and/or a US/Canada mobile number (and tick the texting consent box) to get alerts through
`https://www.bretttomita.com/api/page-connect/notify`. After launch, the launched tab is watched for up to
30 minutes; on each page load (and single-page-app route change) a small script classifies the page:

- **connected** — sent on the first load of the target page
- **verify** — the site shows a human check (press-and-hold, CAPTCHA, Cloudflare / Akamai / Imperva / DataDome
  challenge pages) or a sign-in page. Repeats at most every 5 minutes.
- **arrived** — the product, cart or checkout page loaded (the target URL itself, a recognised product path, or a
  visible "Add to cart" / "Buy now" button). Watching stops after this.

Waiting rooms (Queue-it and similar) are recognised and don't alert; you'll get **arrived** when the queue lets you
through. Page Connect only *notices* these pages; you complete any check yourself.

### Stock watch and add to cart (retail sites)
Choose **Watch for stock** in the popup, paste a product page URL, and press Start. Supported stores: Pokémon Center,
Target, Walmart, Sam's Club, Best Buy, Costco, GameStop and Amazon.

- The product page opens in a background tab, in your own signed-in Chrome session, and is reloaded on the interval
  you pick (30 seconds to 5 minutes) for up to 24 hours.
- When the page offers the item, the extension presses the page's own **Add to cart** button once, waits for the page
  to confirm (cart count goes up, an "added to cart" message, or the cart page opens), then opens your cart in that
  tab, shows a desktop notification, and sends a **carted** email/text with a link to the store's cart if you entered
  a contact.
- If the press can't be confirmed (an options dialog, a site change), or you leave **Add it to my cart** unticked,
  you get an **instock** alert with a link to the product page instead.
- **You check out and pay.** Nothing past the cart is automated.
- A sign-in page, human check or waiting room pauses the watch: the tab is not reloaded (so a queue spot is kept).
  While paused, the page is re-read every 2 seconds (without reloading), so the add to cart happens within seconds
  of a check being cleared or a hold ending. Best Buy's "Please wait" hold after a press is handled the same way.
- **You complete human checks yourself** — Page Connect doesn't solve or bypass them. It gets them in front of you
  fast instead (see below).
- The button is only ever pressed on the product page you entered (same path, or the same item number after a
  redirect), never on another product's button in a carousel or on a page the store redirected to.

To combine it with a timed drop, stay in **Open at a set time** and tick **Add it to my cart**: the launch works as
usual and the watch takes over the launched tab.

Each store's cart URL and buy-box selectors live in `retailers.js`. The selectors are hints tried first; the button
is otherwise found by its text ("Add to cart", "Ship it", "Pre-order"), so update them if a store changes its page.
Carts belong to your browser session: the emailed cart link shows the item in the browser running the extension, or
on another device signed in to the same store account.

### When a site needs you (sign-in or human check)
Whenever a watched page, a drop's prep tab, or a launched page shows a sign-in page or a human check
(press-and-hold, CAPTCHA, Cloudflare / Akamai / Imperva / DataDome challenge):

- The tab is switched to and its window brought to the front, a chime plays, and a desktop notification stays up
  until you click or dismiss it (clicking it takes you to the tab).
- The desktop alert repeats every minute until the check is gone, and is skipped while you're already on that tab.
- With an email/phone set, a **verify** alert is sent right away and then at most every 5 minutes, up to 3 per check
  (the alert service allows about 10 per hour per recipient, which keeps room for the cart-ready alert).

### Retail drops: sign in at T−5 minutes
For a timed launch on a supported store, the store's homepage opens in a tab **5 minutes early** (with an alert) so
you can sign in and clear any check while nothing is at stake. That tab is watched for checks, is never reloaded, and
becomes the launch tab at T−0. Latency is timed with plain `GET`s for a static file (`pingPath`) rather than `HEAD`
requests or a made-up 404 page, which store firewalls tend to treat as bot traffic.

## Project structure

- `manifest.json` — MV3 manifest (service worker, permissions, host permissions)
- `background.js` — the scheduling engine (alarms, pings, adjusted launch, warm tab)
- `watch.js` — the stock watch (interval reloads, in-page add to cart, cart-ready alerts)
- `retailers.js` — supported stores: domains, cart URLs, buy-box selectors
- `attention.js` — bringing a tab that needs you to the front: focus, chime, desktop notification
- `offscreen.html` / `offscreen.js` — plays the chime (a service worker can't play audio)
- `shared.js` — alert sending and the human-check / waiting-room signals both engines use
- `popup.html` / `popup.css` — dark-mode UI
- `popup.js` — input validation, timezone → epoch conversion, messaging, status UI

## Permissions (why they’re needed)

- **`storage`**: save your configuration + persisted run state between service worker wake-ups
- **`tabs`**: create/update a tab for warmup + launch navigation
- **`alarms`**: schedule long waits reliably in MV3 (wake the service worker)
- **`windows`**: bring the target Chrome window to the foreground at launch
- **`power`**: request “keep awake” during the critical countdown windows to avoid OS sleep/throttling
- **`scripting`**: measure IPC overhead, inject the in-tab heartbeat, classify pages for alerts, and check /
  press the buy button during a stock watch
- **`notifications`**: desktop "your cart is ready" and "this site needs you" notifications
- **`offscreen`**: a hidden page that plays the chime
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
   - Optionally an **email** and/or **phone number** for alerts
   - Or pick **Watch for stock** and enter a store's product page instead of a time
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

