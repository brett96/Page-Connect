/**
 * Getting the user to a tab that needs them: a sign-in page or a human check (press-and-hold,
 * CAPTCHA, a bot-check page). Page Connect never completes those itself; this only shortens the
 * time until the user does, by bringing the tab and window to the front, playing a chime, and
 * showing a desktop notification that stays until it's clicked or dismissed.
 *
 * Nothing happens while the user is already looking at the tab (it's the active tab of the focused
 * window), so someone typing their password isn't interrupted every minute.
 */

/** While a check is waiting on the user, alert on the desktop again this often. */
export const ATTENTION_REPEAT_MS = 60_000;
/**
 * Email/text reminders for the same check: this often, and at most this many per check. The site
 * allows about 10 emails/texts an hour per recipient, so this leaves room for the cart-ready alert.
 */
export const REMOTE_VERIFY_MS = 5 * 60_000;
export const REMOTE_VERIFY_MAX = 3;

const PREFIX = "pageConnectCheck:";
const OFFSCREEN_URL = "offscreen.html";
export const MSG_CHIME = "PAGE_CONNECT_CHIME";

/** True if the tab is the active tab of the window that has focus. */
async function inFront(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) return false;
    const win = await chrome.windows.get(tab.windowId);
    return win.focused && win.state !== "minimized";
  } catch {
    return false;
  }
}

/** Plays the chime from an offscreen document (a service worker has no audio). */
export async function playChime() {
  if (!chrome.offscreen) return;
  try {
    const open = await chrome.runtime.getContexts?.({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (!open?.length) {
      await chrome.offscreen
        .createDocument({
          url: OFFSCREEN_URL,
          reasons: ["AUDIO_PLAYBACK"],
          justification: "Chime when a page needs the user to sign in or complete a check.",
        })
        .catch((e) => {
          // Two alerts at once: the other one created it.
          if (!/single offscreen/i.test(String(e))) throw e;
        });
    }
    await chrome.runtime.sendMessage({ type: MSG_CHIME });
  } catch (e) {
    console.warn("Chime failed:", e);
  }
}

/**
 * Bring `tabId` to the user: focus it, chime, and show a sticky desktop notification.
 * @param {number} tabId
 * @param {string} title
 * @param {string} message
 * @returns {Promise<boolean>} false if skipped because the user is already on the tab
 */
export async function demandAttention(tabId, title, message) {
  if (await inFront(tabId)) return false;
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId != null) {
      const win = await chrome.windows.get(tab.windowId);
      // Only change the window's state if it's minimized: on some platforms an explicit state
      // change drops fullscreen or resizes the window.
      await chrome.windows.update(tab.windowId, win.state === "minimized" ? { focused: true, state: "normal" } : { focused: true });
    }
  } catch (e) {
    console.warn("Couldn't bring the tab forward:", e);
  }
  void playChime();
  try {
    const id = `${PREFIX}${tabId}`;
    // Clear first so a repeat pops up again instead of silently replacing the old one.
    await chrome.notifications.clear(id);
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icon.png"),
      title,
      message,
      priority: 2,
      requireInteraction: true,
    });
  } catch (e) {
    console.warn("Desktop notification failed:", e);
  }
  return true;
}

/** The check was dealt with: take the notification down. */
export async function clearAttention(tabId) {
  await chrome.notifications?.clear(`${PREFIX}${tabId}`).catch(() => {});
}

/**
 * Notification click: go to the tab that needs the user.
 * @returns {boolean} true if the notification was one of these
 */
export function handleAttentionClick(notificationId) {
  if (!notificationId.startsWith(PREFIX)) return false;
  const tabId = Number(notificationId.slice(PREFIX.length));
  void (async () => {
    await chrome.notifications.clear(notificationId).catch(() => {});
    try {
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      /* tab closed */
    }
  })();
  return true;
}
