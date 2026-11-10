/**
 * Stock watch: keep a product page open in a tab, re-check it on an interval, and when the item can
 * be bought, press the page's own "Add to cart" button once and tell the user their cart is ready.
 *
 * It works in the user's own tab and session, like a person refreshing the page:
 *   - one page load per interval (30 s minimum), no parallel sessions, quantity as the page defaults;
 *   - a human check, sign-in page or waiting room pauses the watch (no reloads, so a queue spot is
 *     kept) and alerts the user, who completes it themselves;
 *   - it stops at the cart. Checkout and payment are left to the user.
 *
 * State lives in `chrome.storage.local` and ticks come from `chrome.alarms`, so the watch survives
 * the service worker sleeping.
 */

import { retailerFor } from "./retailers.js";
import { PAGE_SIGNALS, hasContact, sendNotify } from "./shared.js";

export const MSG_WATCH = "PAGE_CONNECT_WATCH";
/** Active watch: see `startWatch` for the shape. */
export const WATCH_KEY = "pageConnectWatch";
/** How the last watch ended: { kind, text, link, tabId, at }. Shown by the popup. */
export const WATCH_RESULT_KEY = "pageConnectWatchResult";
export const WATCH_ALARM = "pageConnectWatchTick";

export const MIN_INTERVAL_SEC = 30;
const WATCH_MAX_MS = 24 * 60 * 60_000;
const VERIFY_REPEAT_MS = 5 * 60_000;
/** After this many presses without a confirmed add, stop pressing and just alert. */
const MAX_CLICKS = 3;
const NOTIFICATION_ID = "pageConnectWatch";

function broadcast(watching, text, kind, link) {
  chrome.runtime.sendMessage({ type: MSG_WATCH, watching, text, kind: kind ?? null, link: link ?? null }).catch(() => {});
}

export async function getWatch() {
  const w = (await chrome.storage.local.get(WATCH_KEY))[WATCH_KEY];
  return w && typeof w === "object" ? w : null;
}

const clock = () => new Date().toLocaleTimeString();

/**
 * @param {{ url: string, tabId?: number | null, autoCart: boolean, intervalSec: number,
 *           notify?: import("./shared.js").NotifyContact | null }} opts
 * `tabId`: watch a tab that is already loading the page (a scheduled launch); otherwise a
 * background tab is opened.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function startWatch(opts) {
  const retailer = retailerFor(opts.url);
  if (!retailer) return { ok: false, error: "Stock watch works on supported retail sites only." };

  let tabId = opts.tabId ?? null;
  let windowId = null;
  try {
    const tab = tabId == null ? await chrome.tabs.create({ url: opts.url, active: false }) : await chrome.tabs.get(tabId);
    tabId = tab.id ?? null;
    windowId = tab.windowId ?? null;
  } catch (e) {
    return { ok: false, error: `Couldn't open the product page: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (tabId == null) return { ok: false, error: "Couldn't open the product page." };
  // Memory Saver would otherwise unload a background tab that sits for hours.
  chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});

  const intervalSec = Math.max(MIN_INTERVAL_SEC, Math.round(Number(opts.intervalSec) || MIN_INTERVAL_SEC));
  const statusText = `Watching ${retailer.name} — loading the product page…`;
  await chrome.storage.local.remove(WATCH_RESULT_KEY);
  await chrome.storage.local.set({
    [WATCH_KEY]: {
      tabId,
      windowId,
      url: opts.url,
      autoCart: opts.autoCart !== false,
      intervalSec,
      notify: hasContact(opts.notify) ? opts.notify : null,
      until: Date.now() + WATCH_MAX_MS,
      checks: 0,
      clicks: 0,
      /** Don't reload: the page is waiting on the user or on a queue. */
      hold: false,
      lastState: null,
      verifyAt: 0,
      statusText,
    },
  });
  await chrome.alarms.create(WATCH_ALARM, { periodInMinutes: intervalSec / 60 });
  keepAwake();
  broadcast(true, statusText);
  // The tab may have finished loading before the state was stored.
  void runCheck(tabId);
  return { ok: true };
}

function keepAwake() {
  try {
    chrome.power?.requestKeepAwake?.("system");
  } catch {
    /* ignore */
  }
}

/**
 * End the watch and record why.
 * @param {"carted" | "instock" | "stopped" | "expired" | "closed"} kind
 * @param {object | null} watch the state being ended (null: read it)
 * @param {string} [title] product page title, for the desktop notification
 */
async function finish(kind, watch, title) {
  const w = watch ?? (await getWatch());
  await chrome.alarms.clear(WATCH_ALARM);
  await chrome.storage.local.remove(WATCH_KEY);
  try {
    chrome.power?.releaseKeepAwake?.();
  } catch {
    /* ignore */
  }
  if (!w) return;

  const retailer = retailerFor(w.url);
  const shop = retailer?.name ?? "the store";
  let text;
  let link = null;
  if (kind === "carted") {
    text = `Added to your ${shop} cart at ${clock()}. Check out now — items in a cart aren't reserved.`;
    link = retailer?.cartUrl ?? w.url;
  } else if (kind === "instock") {
    text = w.autoCart
      ? `In stock at ${shop} (${clock()}), but the add to cart couldn't be confirmed. Check the product page and your cart.`
      : `In stock at ${shop} (${clock()}).`;
    link = w.url;
  } else if (kind === "expired") {
    text = "Stock watch ended after 24 hours without the item becoming available.";
  } else if (kind === "closed") {
    text = "Stock watch ended: its tab was closed.";
  } else {
    text = "Stock watch stopped.";
  }

  await chrome.storage.local.set({ [WATCH_RESULT_KEY]: { kind, text, link, tabId: w.tabId, at: Date.now() } });
  broadcast(false, text, kind, link);

  if (kind === "carted" || kind === "instock") {
    // Bring the user to the cart (or the product page if the add wasn't confirmed).
    chrome.tabs.update(w.tabId, kind === "carted" ? { url: link, active: true } : { active: true }).catch(() => {});
    if (typeof w.windowId === "number") chrome.windows.update(w.windowId, { drawAttention: true }).catch(() => {});
    try {
      chrome.notifications?.create(NOTIFICATION_ID, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon.png"),
        title: kind === "carted" ? `Your ${shop} cart is ready` : `In stock at ${shop}`,
        message: `${title ? `${title.slice(0, 80)}\n` : ""}${kind === "carted" ? "Click to open your cart and check out." : "Click to open the product page."}`,
        priority: 2,
        requireInteraction: true,
      });
    } catch (e) {
      console.warn("Desktop notification failed:", e);
    }
    if (w.notify) void sendNotify(w.notify, kind, w.url);
  }
}

/** Popup "Stop" / a new run replacing this one. */
export async function stopWatch() {
  const w = await getWatch();
  if (w) await finish("stopped", w);
}

/** Desktop notification click: go to the cart / product tab. */
export async function handleNotificationClick(notificationId) {
  if (notificationId !== NOTIFICATION_ID) return;
  chrome.notifications.clear(notificationId);
  const res = (await chrome.storage.local.get(WATCH_RESULT_KEY))[WATCH_RESULT_KEY];
  if (!res?.link) return;
  try {
    const tab = await chrome.tabs.update(res.tabId, { active: true });
    if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    await chrome.tabs.create({ url: res.link, active: true });
  }
}

/**
 * Runs inside the product page (must be self-contained). Works out what the page is showing and,
 * if the item can be added and `cfg.autoCart` is set, presses the add-to-cart button once and waits
 * for the page to confirm.
 *
 * Returns `{ state, title?, detail?, clicked? }` where state is:
 *   "verify"  human check or sign-in needs the user      "queue"   waiting room / "please wait"
 *   "offpage" the tab is no longer on the product page   "oos"     shown as sold out / unavailable
 *   "unknown" no buy button found                        "instock" can be added (autoCart off)
 *   "carted"  added and confirmed                        "clicked" pressed, no confirmation seen
 *   "failed"  pressed and the page showed an error
 *
 * @param {{ url: string, autoCart: boolean, add: string[], soldOut: string[], cartCount: string[],
 *           signals: typeof PAGE_SIGNALS }} cfg
 */
export async function watchPage(cfg) {
  const challengeText = new RegExp(cfg.signals.challengeText, "i");
  const queueText = new RegExp(cfg.signals.queueText, "i");
  const signInPath = new RegExp(cfg.signals.signInPath, "i");
  const ADD_TEXT = /^(add to (cart|bag)|ship it|pre-?order( now)?)$/i;
  const SOLD_TEXT = /^(sold out|out of stock|(currently )?unavailable|coming soon|notify me.*)$/i;
  const WAIT_TEXT = /please wait|adding|in line|hold tight/i;
  const CONFIRM_TEXT = /added to (your )?(cart|bag)|item added|in your (cart|bag)/i;
  const ERROR_TEXT =
    /could ?n[o'’]t (be )?add|unable to add|not able to add|something went wrong|try again|purchase limit|limit reached|no longer available/i;
  // Other products' buttons (carousels, "similar items") are never the one to press.
  const NOT_BUY_BOX =
    '[class*="carousel" i],[class*="recommend" i],[class*="sponsored" i],[class*="similar" i],[class*="related" i],[data-test*="carousel" i],[data-testid*="carousel" i]';
  const BUTTONS = 'button, input[type="submit"], input[type="button"], [role="button"]';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const enabled = (el) => !el.disabled && el.getAttribute("aria-disabled") !== "true";
  const label = (el) =>
    (el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
  const usable = (el) => visible(el) && !el.closest(NOT_BUY_BOX);
  const title = () => (document.title || "").trim();
  const bodyText = () => document.body?.innerText || "";

  const blocker = () => {
    const head = bodyText().slice(0, 600);
    if (
      cfg.signals.challengeSelectors.some((s) => visible(document.querySelector(s))) ||
      challengeText.test(title()) ||
      challengeText.test(head)
    ) {
      return "verify";
    }
    if (/queue-it\.net$/i.test(location.hostname) || queueText.test(title()) || queueText.test(head)) return "queue";
    if (signInPath.test(location.pathname) || [...document.querySelectorAll('input[type="password"]')].some(visible)) {
      return "verify";
    }
    return null;
  };

  // Still the product the user asked for? Same path, or the same item number after a redirect to
  // the canonical URL. Never press a button on any other page.
  const target = new URL(cfg.url);
  const bare = (h) => h.replace(/^www\./, "");
  const trim = (p) => p.replace(/\/+$/, "");
  const ids = (target.pathname + target.search).match(/\d{5,}/g) || [];
  const onProduct = () =>
    bare(location.hostname) === bare(target.hostname) &&
    (trim(location.pathname) === trim(target.pathname) || ids.some((id) => (location.pathname + location.search).includes(id)));

  const findAdd = () => {
    for (const sel of cfg.add) {
      for (const el of document.querySelectorAll(sel)) {
        const text = label(el);
        if (usable(el) && enabled(el) && !SOLD_TEXT.test(text) && !WAIT_TEXT.test(text)) return el;
      }
    }
    for (const el of document.querySelectorAll(BUTTONS)) {
      if (usable(el) && enabled(el) && ADD_TEXT.test(label(el))) return el;
    }
    return null;
  };
  const soldOut = () =>
    cfg.soldOut.some((s) => visible(document.querySelector(s))) ||
    [...document.querySelectorAll(BUTTONS)].some((el) => usable(el) && SOLD_TEXT.test(label(el)));
  const waiting = () => [...document.querySelectorAll(BUTTONS)].some((el) => usable(el) && WAIT_TEXT.test(label(el)));
  const cartCount = () => {
    for (const sel of cfg.cartCount) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const m = /\d+/.exec(`${label(el)} ${el.getAttribute("aria-label") || ""}`);
      return m ? Number(m[0]) : 0;
    }
    return null;
  };
  const errorSeen = () => {
    for (const el of document.querySelectorAll('[role="alert"], [role="dialog"], [aria-live], [class*="error" i], [class*="toast" i]')) {
      const m = visible(el) && ERROR_TEXT.exec(label(el));
      if (m) return label(el).slice(0, 140);
    }
    return null;
  };

  // 1) What is the page showing? Poll: buy boxes, checks and waiting rooms render after load.
  const pressed = globalThis.__pageConnectCart;
  let button = null;
  for (let i = 0; i < 16 && !button; i++) {
    const b = blocker();
    if (b) return { state: b, title: title() };
    if (onProduct()) {
      // An earlier press is still being held in line by the site.
      if (pressed && waiting()) return { state: "queue", title: title() };
      button = findAdd();
      if (!button && i >= 4 && soldOut()) return { state: "oos", title: title() };
    }
    if (!button) await sleep(500);
  }
  if (!onProduct()) return { state: "offpage", detail: location.href };
  if (!button) return { state: soldOut() ? "oos" : "unknown", title: title() };
  if (!cfg.autoCart) return { state: "instock", title: title() };

  // 2) Press it once and wait for the page to confirm.
  const before = { count: cartCount(), confirmed: CONFIRM_TEXT.test(bodyText()), error: errorSeen() };
  const flag = (globalThis.__pageConnectCart = { waitSeen: false });
  button.scrollIntoView({ block: "center" });
  button.click();

  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (/\/(cart|checkout|basket)\b/i.test(location.pathname)) return { state: "carted", title: title(), clicked: true };
    const count = cartCount();
    if (count != null && before.count != null && count > before.count) return { state: "carted", title: title(), clicked: true };
    if (!before.confirmed && CONFIRM_TEXT.test(bodyText())) return { state: "carted", title: title(), clicked: true };
    const b = blocker();
    if (b) return { state: b, title: title(), clicked: true };
    const err = before.error ? null : errorSeen();
    if (err) return { state: "failed", detail: err, title: title(), clicked: true };
    if (waiting()) flag.waitSeen = true;
  }
  return { state: flag.waitSeen && waiting() ? "queue" : "clicked", title: title(), clicked: true };
}

let busy = false;
let again = false;

/**
 * Inspect the watched tab's current page and act on what it shows. Serialized: a navigation that
 * lands mid-check queues one more pass.
 * @param {number} tabId
 */
export async function runCheck(tabId) {
  if (busy) {
    again = true;
    return;
  }
  busy = true;
  // The in-page check can take ~25 s; keep the worker from being suspended meanwhile.
  const alive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 10_000);
  try {
    do {
      again = false;
      const w = await getWatch();
      if (!w || w.tabId !== tabId) return;
      const retailer = retailerFor(w.url);
      if (!retailer) return;

      let tab;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        await finish("closed", w);
        return;
      }
      if (tab.status !== "complete") continue; // its "complete" event will call back

      // After a check / wait / error the earlier press didn't go through, so pressing again is fine.
      const autoCart = w.autoCart && w.clicks < MAX_CLICKS;
      let res;
      try {
        const [out] = await chrome.scripting.executeScript({
          target: { tabId },
          func: watchPage,
          args: [
            {
              url: w.url,
              autoCart,
              add: retailer.add,
              soldOut: retailer.soldOut,
              cartCount: retailer.cartCount,
              signals: PAGE_SIGNALS,
            },
          ],
        });
        res = out?.result ?? { state: "error" };
      } catch (e) {
        // Error pages and mid-navigation documents can't be scripted; the next tick reloads.
        console.warn("watchPage failed:", e);
        res = { state: "error" };
      }

      // Stopped (or replaced) while the page was being checked.
      const cur = await getWatch();
      if (!cur || cur.tabId !== tabId || cur.until !== w.until) return;

      const next = { ...w, checks: w.checks + 1, clicks: w.clicks + (res.clicked ? 1 : 0), lastState: res.state };
      if (res.state === "carted") {
        await finish("carted", next, res.title);
        return;
      }
      if (res.state === "instock" || res.state === "clicked") {
        await finish("instock", next, res.title);
        return;
      }

      next.hold = res.state === "verify" || res.state === "queue";
      if (res.state === "verify" && w.notify && Date.now() - w.verifyAt > VERIFY_REPEAT_MS) {
        next.verifyAt = Date.now();
        void sendNotify(w.notify, "verify", w.url);
      }
      const what = {
        verify: "the site is asking you to sign in or complete a check. Do that in the watched tab; it won't be reloaded meanwhile",
        queue: "in a waiting room / being held by the site. Leaving the tab alone",
        oos: "not available yet",
        unknown: "no add-to-cart button on the page yet",
        offpage: "the site sent the tab to another page; going back on the next check",
        failed: `the site wouldn't add it${res.detail ? ` (“${res.detail}”)` : ""}; trying again on the next check`,
        error: "the page didn't load; retrying on the next check",
      }[res.state];
      next.statusText = `Watching ${retailer.name} — ${clock()}: ${what}. (${next.checks} check${next.checks === 1 ? "" : "s"}, every ${w.intervalSec}s)`;
      await chrome.storage.local.set({ [WATCH_KEY]: next });
      broadcast(true, next.statusText);
    } while (again);
  } finally {
    clearInterval(alive);
    busy = false;
  }
}

/** Alarm tick: reload the product page (its load triggers `runCheck`), or re-check a held page. */
export async function handleWatchAlarm() {
  const w = await getWatch();
  if (!w) {
    await chrome.alarms.clear(WATCH_ALARM);
    return;
  }
  if (Date.now() > w.until) {
    await finish("expired", w);
    return;
  }
  if (busy) return;
  keepAwake();
  try {
    await chrome.tabs.get(w.tabId);
  } catch {
    await finish("closed", w);
    return;
  }
  if (w.hold) {
    await runCheck(w.tabId);
  } else if (w.lastState === "offpage" || w.lastState === "error") {
    await chrome.tabs.update(w.tabId, { url: w.url }).catch(() => {});
  } else {
    await chrome.tabs.reload(w.tabId).catch(() => {});
  }
}

/** @param {number} tabId */
export async function handleWatchTabRemoved(tabId) {
  const w = await getWatch();
  if (w?.tabId === tabId) await finish("closed", w);
}
