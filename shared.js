/** Pieces shared by the launch engine (background.js) and the stock watch (watch.js). */

export const NOTIFY_ENDPOINT = "https://www.bretttomita.com/api/page-connect/notify";
export const SOLVE_ENDPOINT = "https://www.bretttomita.com/api/page-connect/solve";

/**
 * How a page shows that it needs the user: a human check, a waiting room, or a sign-in page.
 * Plain data (regex sources, not RegExp objects) so it can be passed into injected page scripts.
 */
export const PAGE_SIGNALS = {
  challengeSelectors: [
    "#px-captcha", // HUMAN / PerimeterX "press & hold"
    "#sec-if-cpt-container", // Akamai
    "#challenge-form",
    "#challenge-stage", // Cloudflare
    ".g-recaptcha",
    ".h-captcha",
    'iframe[src*="captcha-delivery.com"]', // DataDome
    'iframe[src*="recaptcha"]',
    'iframe[src*="hcaptcha.com"]',
    'iframe[src*="arkoselabs"]',
    'iframe[src*="funcaptcha"]',
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="_Incapsula_Resource"]', // Imperva
  ],
  challengeText:
    "press (&|and) hold|verify (that )?you('| a)re (a )?human|are you a (robot|human)|robot or human|confirm you('| a)re (not a robot|human)|pardon our interruption|access to this page has been denied|just a moment\\.\\.\\.|checking your browser",
  queueText: "waiting ?room|you('| a)re (now )?in (the )?(line|queue)|estimated wait|queue-it",
  signInPath: "\\/(log-?in|sign-?in|account\\/login|ap\\/signin)\\b",
};

/**
 * @typedef {{ email?: string, phone?: string, smsConsent?: boolean }} NotifyContact
 * @typedef {"connected" | "verify" | "arrived" | "instock" | "carted"} NotifyEvent
 */

/** @param {NotifyContact | null | undefined} notify */
export function hasContact(notify) {
  return Boolean(notify && (notify.email || (notify.phone && notify.smsConsent)));
}

/**
 * Email/SMS via the Page Connect site. Best-effort: a failed alert never affects the run.
 * @param {NotifyContact} notify
 * @param {NotifyEvent} event
 * @param {string} url
 */
export async function sendNotify(notify, event, url) {
  try {
    const res = await fetch(NOTIFY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: notify.email || undefined,
        phone: notify.smsConsent ? notify.phone || undefined : undefined,
        smsConsent: notify.smsConsent === true,
        event,
        url,
      }),
    });
    if (!res.ok) console.warn(`Notify ${event} failed: HTTP ${res.status}`, await res.text().catch(() => ""));
  } catch (e) {
    console.warn(`Notify ${event} failed:`, e);
  }
}

/**
 * Detects challenge metadata in a tab, requests a solution from /api/page-connect/solve,
 * and injects the token into the page.
 * @param {number} tabId
 * @param {string} fallbackUrl
 * @returns {Promise<boolean>} true if a token was solved and injected
 */
export async function attemptSolveChallenge(tabId, fallbackUrl) {
  try {
    const [probe] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const visible = (el) => !!el && el.getClientRects().length > 0;
        if ([...document.querySelectorAll('input[type="password"]')].some(visible)) return null;

        const el = document.querySelector("[data-sitekey]");
        if (!el) return null;
        const sitekey = el.getAttribute("data-sitekey");
        if (!sitekey) return null;

        const isTurnstile =
          el.classList.contains("cf-turnstile") ||
          !!document.querySelector('input[name="cf-turnstile-response"]');
        const isHCaptcha =
          el.classList.contains("h-captcha") ||
          !!document.querySelector('textarea[name="h-captcha-response"]');

        return {
          sitekey,
          pageUrl: location.href,
          taskType: isTurnstile
            ? "AntiTurnstileTaskProxyLess"
            : isHCaptcha
              ? "HCaptchaTaskProxyLess"
              : "ReCaptchaV2TaskProxyLess",
        };
      },
    });

    const info = probe?.result;
    if (!info) return false;

    const res = await fetch(SOLVE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskType: info.taskType,
        websiteURL: info.pageUrl || fallbackUrl,
        websiteKey: info.sitekey,
      }),
    });
    if (!res.ok) return false;

    const { solution } = await res.json();
    const token = solution?.token || solution?.gRecaptchaResponse;
    if (!token) return false;

    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (solvedToken) => {
        const selectors = [
          'input[name="cf-turnstile-response"]',
          'textarea[name="g-recaptcha-response"]',
          'textarea[name="h-captcha-response"]',
        ];
        for (const sel of selectors) {
          const input = document.querySelector(sel);
          if (input) {
            input.value = solvedToken;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        const form = document.querySelector("form");
        if (form && typeof form.submit === "function") form.submit();
      },
      args: [token],
    });
    return true;
  } catch (e) {
    console.warn("attemptSolveChallenge failed:", e);
    return false;
  }
}

function cubicBezier(t, p0, p1, p2, p3) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/**
 * Dispatches realistic mouse movements along a Bézier trajectory and generates
 * hardware-trusted mouse events (Event.isTrusted === true) via the Chrome DevTools Protocol.
 * @param {number} tabId
 * @param {string[]} [customSelectors]
 * @returns {Promise<boolean>}
 */
export async function performTrustedClick(tabId, customSelectors = []) {
  const [coordsRes] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async (selectors) => {
      const BUY_TEXT = /^\s*(add to (cart|bag)|buy now|pre-?order( now)?|ship it)\s*$/i;
      const visible = (el) => !!el && el.getClientRects().length > 0 && !el.disabled;
      let btn = selectors.map((s) => document.querySelector(s)).find(visible);
      if (!btn) {
        btn = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')].find(
          (b) => visible(b) && BUY_TEXT.test(b.textContent || b.value || ""),
        );
      }
      if (!btn) return null;

      btn.scrollIntoView({ behavior: "smooth", block: "center" });
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 150));

      const rect = btn.getBoundingClientRect();
      return {
        start: {
          x: Math.round(window.innerWidth * (0.3 + Math.random() * 0.4)),
          y: Math.round(window.innerHeight * (0.2 + Math.random() * 0.3)),
        },
        target: {
          x: Math.round(rect.left + rect.width * (0.25 + Math.random() * 0.5)),
          y: Math.round(rect.top + rect.height * (0.25 + Math.random() * 0.5)),
        },
      };
    },
    args: [customSelectors],
  });

  const coords = coordsRes?.result;
  if (!coords) return false;

  const debuggee = { tabId };
  await chrome.debugger.attach(debuggee, "1.3");
  try {
    const { start, target } = coords;
    const steps = 18 + Math.floor(Math.random() * 10);
    const cp1 = {
      x: start.x + (target.x - start.x) * 0.3 + (Math.random() * 40 - 20),
      y: start.y + (Math.random() * 40 - 20),
    };
    const cp2 = {
      x: start.x + (target.x - start.x) * 0.7 + (Math.random() * 20 - 10),
      y: target.y + (Math.random() * 20 - 10),
    };

    for (let i = 1; i <= steps; i++) {
      const t = 1 - Math.pow(1 - i / steps, 2); // Fitts's law deceleration
      const x = Math.round(cubicBezier(t, start.x, cp1.x, cp2.x, target.x));
      const y = Math.round(cubicBezier(t, start.y, cp1.y, cp2.y, target.y));
      await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x,
        y,
        pointerType: "mouse",
      });
      await new Promise((r) => setTimeout(r, 8 + Math.random() * 8));
    }

    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: target.x,
      y: target.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 45));
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: target.x,
      y: target.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    return true;
  } finally {
    await chrome.debugger.detach(debuggee).catch(() => {});
  }
}