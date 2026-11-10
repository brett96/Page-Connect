/** Pieces shared by the launch engine (background.js) and the stock watch (watch.js). */

export const NOTIFY_ENDPOINT = "https://www.bretttomita.com/api/page-connect/notify";

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
