/**
 * Retail sites the stock watch can add to cart on.
 *
 * `pingPath` is a same-origin static file used to time latency before a scheduled drop.
 * `add`, `soldOut` and `cartCount` are CSS selectors for the main buy box. They are hints, tried
 * first; if a site changes its markup the watch falls back to finding the button by its text
 * ("Add to cart", "Ship it", "Pre-order"), so a stale selector degrades instead of breaking.
 */

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   domains: string[],
 *   cartUrl: string,
 *   pingPath: string,
 *   add: string[],
 *   soldOut: string[],
 *   cartCount: string[],
 * }} Retailer
 */

/** @type {Retailer[]} */
export const RETAILERS = [
  {
    id: "pokemoncenter",
    name: "Pokémon Center",
    domains: ["pokemoncenter.com"],
    cartUrl: "https://www.pokemoncenter.com/cart",
    pingPath: "/favicon.ico",
    add: ['button[class*="add-to-cart-button"]'],
    soldOut: [],
    cartCount: ['a[href$="/cart"]'],
  },
  {
    id: "target",
    name: "Target",
    domains: ["target.com"],
    cartUrl: "https://www.target.com/cart",
    pingPath: "/favicon.ico",
    add: [
      'button[data-test="shippingButton"]',
      'button[data-test="shipItButton"]',
      'button[data-test="preorderButton"]',
      'button[id^="addToCartButtonOrTextIdFor"]',
    ],
    soldOut: ['[data-test="soldOutBlock"]', '[data-test="NonbuyableSection"]'],
    cartCount: ['[data-test="@web/CartLink"]'],
  },
  {
    id: "walmart",
    name: "Walmart",
    domains: ["walmart.com"],
    cartUrl: "https://www.walmart.com/cart",
    pingPath: "/favicon.ico",
    add: ['[data-testid="add-to-cart-section"] button', 'button[data-dca-name="ItemBuyBoxAddToCartButton"]'],
    soldOut: [],
    cartCount: ['[data-automation-id="cart-item-count"]', "#cart-badge"],
  },
  {
    id: "samsclub",
    name: "Sam's Club",
    domains: ["samsclub.com"],
    cartUrl: "https://www.samsclub.com/cart",
    pingPath: "/favicon.ico",
    add: ['[data-testid="add-to-cart-section"] button'],
    soldOut: [],
    cartCount: ['[data-automation-id="cart-item-count"]'],
  },
  {
    id: "bestbuy",
    name: "Best Buy",
    domains: ["bestbuy.com"],
    cartUrl: "https://www.bestbuy.com/cart",
    pingPath: "/favicon.ico",
    add: [
      'button[data-button-state="ADD_TO_CART"]',
      'button[data-button-state="PRE_ORDER"]',
      'button[data-test-id="add-to-cart"]',
    ],
    soldOut: ['button[data-button-state="SOLD_OUT"]', 'button[data-button-state="COMING_SOON"]'],
    cartCount: [".cart-link .dot", '[data-testid="cart-count"]'],
  },
  {
    id: "costco",
    name: "Costco",
    domains: ["costco.com"],
    cartUrl: "https://www.costco.com/CheckoutCartDisplayView",
    pingPath: "/favicon.ico",
    add: ["#add-to-cart-btn"],
    soldOut: ["#oos-overlay"],
    cartCount: ["#cart-d .cart-number"],
  },
  {
    id: "gamestop",
    name: "GameStop",
    domains: ["gamestop.com"],
    cartUrl: "https://www.gamestop.com/cart/",
    pingPath: "/favicon.ico",
    add: ["button.add-to-cart"],
    soldOut: [],
    cartCount: [".minicart-quantity"],
  },
  {
    id: "amazon",
    name: "Amazon",
    domains: ["amazon.com"],
    cartUrl: "https://www.amazon.com/gp/cart/view.html",
    pingPath: "/favicon.ico",
    add: ["#add-to-cart-button"],
    soldOut: ["#outOfStock"],
    cartCount: ["#nav-cart-count"],
  },
];

/**
 * @param {string} rawUrl
 * @returns {Retailer | null}
 */
export function retailerFor(rawUrl) {
  let host;
  try {
    host = new URL(String(rawUrl).trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  return RETAILERS.find((r) => r.domains.some((d) => host === d || host.endsWith(`.${d}`))) ?? null;
}
