// ACP checkout sessions, quote half only.
//
// The Agentic Commerce Protocol (2026-04-17) describes a five-step checkout:
// create, get, update, complete, cancel. This implements the first three and
// deliberately stops there. The reason is not effort — it is that the last two
// need something WooCommerce cannot give from outside:
//
//   complete  needs a delegated payment credential, which in practice means
//             the buyer's processor is one of a handful that issue them. The
//             buyer finishes at `continue_url`, on the merchant's own site,
//             through whatever gateway the merchant already runs.
//   reserve   needs ReserveStock::reserve_stock_for_order(), which is PHP and
//             wants an order object. There is no REST route to it. So this
//             never sets `quote_id` / `quote_expires_at`: the protocol's way
//             of saying stock is held, and nothing here holds any.
//
// What it does answer is the part an agent genuinely cannot work out alone:
// the landed total. Tax rules and shipping rates live inside the merchant's
// own store, and no amount of reading the catalogue reveals them. The
// WooCommerce Store API computes both — and needs no merchant credentials to
// do it, so this works on any store with the Store API on, whatever plugins
// and whatever gateway it runs.
//
// Field names throughout are ACP's, not ours. An agent that has read the
// specification should be able to drive this without being taught anything.

/** Protocol metadata, mapped from ACP's HTTP headers by its MCP binding.
 * `Authorization` is deliberately absent there and here: bearer tokens in tool
 * arguments would be visible in schemas the model reads. */
export interface AcpMeta {
  api_version?: string;
  idempotency_key?: string;
  request_id?: string;
  user_agent?: string;
  accept_language?: string;
  [key: string]: unknown;
}

/** The one version of the specification this speaks. */
export const ACP_API_VERSION = "2026-04-17";

export interface AcpTotal {
  type: string;
  display_text: string;
  /** Minor currency units, as an integer — ACP's rule, and already how the
   * Store API reports money alongside `currency_minor_unit`. */
  amount: number;
}

export interface AcpMessage {
  type: "info" | "warning" | "error";
  code?: string;
  content_type: "plain";
  content: string;
}

export interface AcpFulfillmentOption {
  type: "shipping";
  id: string;
  title: string;
  description?: string;
  carrier?: string;
  earliest_delivery_time?: string;
  latest_delivery_time?: string;
  totals: AcpTotal[];
}

export interface AcpLineItem {
  id: string;
  item: { id: string; quantity: number };
  base_amount: number;
  discount: number;
  subtotal: number;
  tax: number;
  total: number;
}

export interface AcpCheckoutSession {
  id: string;
  protocol: { name: "acp"; version: string };
  capabilities: Record<string, unknown>;
  status: string;
  currency: string;
  line_items: AcpLineItem[];
  fulfillment_options: AcpFulfillmentOption[];
  selected_fulfillment_options: Array<{ fulfillment_option_id: string }>;
  totals: AcpTotal[];
  messages: AcpMessage[];
  links: Array<{ type: string; url: string }>;
  fulfillment_details?: { shipping_address?: Record<string, unknown> };
  continue_url?: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// The Store API side
// ---------------------------------------------------------------------------

/** Where the session's state actually lives.
 *
 * WooCommerce already holds the cart, and its Cart-Token already identifies
 * it — so there is nothing here worth storing a second copy of. The session id
 * carries that token instead of a database row pointing at one.
 *
 * The trust boundary is unchanged by this: in ACP, whoever holds a session id
 * can already read and modify that session. Here that is the same statement as
 * "whoever holds the cart token can read and modify the cart", because it is
 * literally the same string. What it does mean is that a session id must be
 * treated as a credential and kept out of logs, exactly as ACP requires.
 */
const SESSION_PREFIX = "cs_";

export function encodeSessionId(cartToken: string): string {
  return SESSION_PREFIX + btoa(cartToken).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeSessionId(sessionId: string): string | null {
  if (!sessionId.startsWith(SESSION_PREFIX)) return null;
  const body = sessionId.slice(SESSION_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/");
  try {
    const token = atob(body + "=".repeat((4 - (body.length % 4)) % 4));
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export interface StoreApiCall {
  path: string;
  body?: unknown;
  cartToken?: string;
}

export interface StoreApiResponse {
  ok: boolean;
  status: number;
  cart: Record<string, unknown> | null;
  cartToken: string | null;
  /** The store's own error message, kept verbatim — "coupon expired" or
   * "only 2 left in stock" is the answer, not something to flatten into a
   * generic failure. */
  errorMessage?: string;
}

const STORE_API = "/wp-json/wc/store/v1";
const FETCH_TIMEOUT_MS = 10_000;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function callStoreApi(
  storeUrl: string, call: StoreApiCall, fetchImpl: FetchLike,
): Promise<StoreApiResponse> {
  const url = `${storeUrl.replace(/\/+$/, "")}${STORE_API}${call.path}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    // Not "Mozilla/..." — this is not a browser, and at least one
    // wordpress.org host refuses non-browser methods from anything that
    // claims to be one. Say what it is.
    "user-agent": "AgentReady Woo/1.0 (+https://app.utilityhouse.xyz/)",
  };
  if (call.body !== undefined) headers["content-type"] = "application/json";
  // A Cart Token stands in for the nonce a browser would send, which is what
  // makes this usable without a session cookie or any merchant credential.
  if (call.cartToken) headers["cart-token"] = call.cartToken;

  try {
    const response = await fetchImpl(url, {
      method: call.body === undefined ? "GET" : "POST",
      headers,
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const cartToken = response.headers.get("cart-token") ?? call.cartToken ?? null;
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* handled below */ }
    if (!response.ok) {
      const asRecord = (parsed ?? {}) as Record<string, unknown>;
      return {
        ok: false, status: response.status, cart: null, cartToken,
        errorMessage: typeof asRecord.message === "string" ? asRecord.message : `store API HTTP ${response.status}`,
      };
    }
    if (parsed === null || typeof parsed !== "object") {
      return { ok: false, status: response.status, cart: null, cartToken, errorMessage: "store API returned a non-JSON body" };
    }
    return { ok: true, status: response.status, cart: parsed as Record<string, unknown>, cartToken };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, cart: null, cartToken: call.cartToken ?? null, errorMessage: `store API unreachable: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// WooCommerce cart -> ACP checkout session
// ---------------------------------------------------------------------------

/** Store API money is a string of minor units ("1250"), paired with
 * `currency_minor_unit`. ACP wants an integer of minor units. Same quantity,
 * so no arithmetic is needed and none is done — parsing a price into a float
 * and multiplying is how money loses a cent. */
function minorUnits(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const text = String(value ?? "").trim();
  if (!/^-?\d+$/.test(text)) return 0;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function total(type: string, display_text: string, amount: number): AcpTotal {
  return { type, display_text, amount };
}

/** Only the totals that carry a number worth showing.
 *
 * A zero `discount` line is not the same as no discount line: the first says
 * "we looked and there is none", which reads to a model as a fact about this
 * cart. Lines that are structurally always present stay; ones that only exist
 * when non-zero are omitted when zero. */
export function totalsFromCart(cart: Record<string, unknown>): AcpTotal[] {
  const t = asRecord(cart.totals);
  const out: AcpTotal[] = [
    total("items_base_amount", "Items", minorUnits(t.total_items)),
  ];
  const discount = minorUnits(t.total_discount);
  if (discount !== 0) out.push(total("discount", "Discount", -Math.abs(discount)));
  const fees = minorUnits(t.total_fees);
  if (fees !== 0) out.push(total("fee", "Fees", fees));
  const shipping = minorUnits(t.total_shipping);
  const shippingChosen = asArray(cart.shipping_rates)
    .some(p => asArray(asRecord(p).shipping_rates).some(r => asRecord(r).selected === true));
  // Shipping only appears once a rate is actually selected. Reporting 0 before
  // that would read as free delivery rather than as an unanswered question.
  if (shippingChosen || shipping !== 0) out.push(total("fulfillment", "Shipping", shipping));
  out.push(total("tax", "Tax", minorUnits(t.total_tax)));
  out.push(total("total", "Total", minorUnits(t.total_price)));
  return out;
}

export function lineItemsFromCart(cart: Record<string, unknown>): AcpLineItem[] {
  return asArray(cart.items).map(raw => {
    const item = asRecord(raw);
    const lt = asRecord(item.totals);
    const subtotal = minorUnits(lt.line_subtotal);
    const lineTotal = minorUnits(lt.line_total);
    return {
      id: String(item.key ?? item.id ?? ""),
      item: { id: String(item.id ?? ""), quantity: Number(item.quantity ?? 0) || 0 },
      base_amount: subtotal,
      // What the cart actually took off this line, rather than a discount
      // field the Store API does not have.
      discount: Math.max(0, subtotal - lineTotal),
      subtotal: lineTotal,
      tax: minorUnits(lt.line_total_tax),
      total: lineTotal + minorUnits(lt.line_total_tax),
    };
  });
}

/** Shipping rates, flattened across packages.
 *
 * `delivery_time` is a free-text field a shipping plugin may or may not set
 * ("2-3 days", "", "Nov 12"). ACP wants RFC 3339 timestamps, and there is no
 * honest way to turn most of those into one — so the text is passed through as
 * the option's description and the timestamp fields are left unset. A wrong
 * delivery date is worse than no delivery date: the buyer plans around it.
 */
export function fulfillmentOptionsFromCart(cart: Record<string, unknown>): AcpFulfillmentOption[] {
  const options: AcpFulfillmentOption[] = [];
  for (const pkg of asArray(cart.shipping_rates)) {
    for (const raw of asArray(asRecord(pkg).shipping_rates)) {
      const rate = asRecord(raw);
      const id = String(rate.rate_id ?? "");
      if (!id) continue;
      const deliveryText = String(rate.delivery_time ?? "").trim();
      const description = String(rate.description ?? "").trim() || undefined;
      options.push({
        type: "shipping",
        id,
        title: String(rate.name ?? "Shipping"),
        ...(deliveryText ? { description: deliveryText } : description ? { description } : {}),
        totals: [total("fulfillment", String(rate.name ?? "Shipping"),
          minorUnits(rate.price) + minorUnits(rate.taxes))],
      });
    }
  }
  return options;
}

function selectedOptions(cart: Record<string, unknown>): Array<{ fulfillment_option_id: string }> {
  const out: Array<{ fulfillment_option_id: string }> = [];
  for (const pkg of asArray(cart.shipping_rates)) {
    for (const raw of asArray(asRecord(pkg).shipping_rates)) {
      const rate = asRecord(raw);
      if (rate.selected === true && rate.rate_id) out.push({ fulfillment_option_id: String(rate.rate_id) });
    }
  }
  return out;
}

/** ACP status for a session this service will never carry to payment.
 *
 * The status vocabulary runs to `ready_for_payment` and beyond, and none of
 * those are reachable here: completion happens on the merchant's own site,
 * through the gateway they already run. Saying `ready_for_payment` because the
 * cart looks complete would invite an agent to call a `complete` tool that
 * does not exist.
 *
 * `not_ready_for_payment` is the true one, and the accompanying message says
 * why and where it does finish — which is the part an agent can act on.
 */
function statusFor(cart: Record<string, unknown>): string {
  return asArray(cart.items).length === 0 ? "incomplete" : "not_ready_for_payment";
}

function messagesFrom(cart: Record<string, unknown>, continueUrl: string | null): AcpMessage[] {
  const messages: AcpMessage[] = [];
  for (const raw of asArray(cart.errors)) {
    const err = asRecord(raw);
    const content = String(err.message ?? "").trim();
    if (content) messages.push({ type: "error", code: String(err.code ?? "store_error"), content_type: "plain", content });
  }
  const needsAddress = asArray(cart.shipping_rates).length === 0;
  if (needsAddress && asArray(cart.items).length > 0) {
    messages.push({
      type: "info", code: "address_required", content_type: "plain",
      content: "Shipping and tax are not final until a destination is set. Call update_checkout_session with fulfillment_details.shipping_address.",
    });
  }
  messages.push({
    type: "info", code: "completion_offsite", content_type: "plain",
    content: continueUrl
      ? `This quote is priced and ready. Payment is not accepted through this protocol — the buyer completes the purchase at ${continueUrl}, on the merchant's own store, using the payment methods it already offers.`
      : "Payment is not accepted through this protocol; the buyer completes the purchase on the merchant's own store.",
  });
  return messages;
}

export interface SessionBuildOptions {
  sessionId: string;
  continueUrl?: string | null;
  links?: Array<{ type: string; url: string }>;
  now?: () => Date;
}

export function sessionFromCart(
  cart: Record<string, unknown>, opts: SessionBuildOptions,
): AcpCheckoutSession {
  const now = (opts.now ?? (() => new Date()))();
  const continueUrl = opts.continueUrl ?? null;
  const shipping = asRecord(asRecord(cart.shipping_address));
  return {
    id: opts.sessionId,
    protocol: { name: "acp", version: ACP_API_VERSION },
    // Declared, not negotiated away: this seller takes no payment and offers
    // no interventions, and an agent should learn that from the session rather
    // than from a failed call.
    capabilities: { payment: { handlers: [] }, interventions: { types: [] }, extensions: [] },
    status: statusFor(cart),
    currency: String(asRecord(cart.totals).currency_code ?? ""),
    line_items: lineItemsFromCart(cart),
    fulfillment_options: fulfillmentOptionsFromCart(cart),
    selected_fulfillment_options: selectedOptions(cart),
    totals: totalsFromCart(cart),
    messages: messagesFrom(cart, continueUrl),
    links: opts.links ?? [],
    ...(Object.keys(shipping).length > 0 ? { fulfillment_details: { shipping_address: shipping } } : {}),
    ...(continueUrl ? { continue_url: continueUrl } : {}),
    updated_at: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The three operations
// ---------------------------------------------------------------------------

export interface QuoteContext {
  storeUrl: string;
  fetchImpl: FetchLike;
  /** Builds the URL the buyer finishes at. Injected rather than imported so
   * this module needs no signing key and can be tested without one. Returning
   * null is a legitimate answer — see the single-item note below. */
  resolveContinueUrl?: (lineItems: AcpLineItem[]) => Promise<string | null>;
  links?: Array<{ type: string; url: string }>;
  now?: () => Date;
}

export type QuoteResult =
  | { ok: true; session: AcpCheckoutSession }
  | { ok: false; code: string; message: string };

function itemsFromPayload(payload: Record<string, unknown>): Array<{ id: number; quantity: number }> {
  return asArray(payload.items).map(raw => {
    const item = asRecord(raw);
    // ACP nests the product under `item`; accept the flat shape too, because
    // a model that has read one example and not the other should still work.
    const inner = asRecord(item.item);
    const id = Number(inner.id ?? item.id ?? 0);
    const quantity = Number(inner.quantity ?? item.quantity ?? 1);
    return { id, quantity };
  }).filter(i => Number.isInteger(i.id) && i.id > 0 && Number.isInteger(i.quantity) && i.quantity > 0);
}

async function finish(
  ctx: QuoteContext, cart: Record<string, unknown>, cartToken: string,
): Promise<QuoteResult> {
  const lineItems = lineItemsFromCart(cart);
  let continueUrl: string | null = null;
  try {
    continueUrl = ctx.resolveContinueUrl ? await ctx.resolveContinueUrl(lineItems) : null;
  } catch {
    // A missing hand-off link degrades the answer; it does not invalidate the
    // prices, which is what was asked for.
    continueUrl = null;
  }
  const session = sessionFromCart(cart, {
    sessionId: encodeSessionId(cartToken),
    continueUrl, links: ctx.links, now: ctx.now,
  });
  if (!continueUrl && lineItems.length > 1) {
    session.messages.push({
      type: "warning", code: "multi_item_handoff",
      content_type: "plain",
      content: "This quote covers several items. WooCommerce can restore only one product per link, so there is no single URL that recreates this whole cart — the buyer adds the items on the store. The totals above are still the store's own calculation for this combination.",
    });
  }
  return { ok: true, session };
}

/** POST /checkout_sessions */
export async function createCheckoutSession(
  ctx: QuoteContext, _meta: AcpMeta, payload: Record<string, unknown>,
): Promise<QuoteResult> {
  const items = itemsFromPayload(payload);
  if (items.length === 0) {
    return { ok: false, code: "invalid_request", message: "items must contain at least one { id, quantity } with a positive integer product id" };
  }

  // Open a cart before putting anything in it.
  //
  // The Store API documents its POST endpoints as needing "a Nonce Token or a
  // Cart Token", which reads like a choice and is not one: there is no cart
  // token until the store has issued you a cart, and a nonce is something only
  // a browser session has. So the first POST of a session is refused —
  // "Missing the Nonce header" — and every mocked test passes anyway, because
  // a fake store has no reason to invent that rule. A live store found it in
  // one call.
  //
  // GET /cart costs one request and answers with the Cart-Token header that
  // every call after it uses.
  const opened = await callStoreApi(ctx.storeUrl, { path: "/cart" }, ctx.fetchImpl);
  if (!opened.cartToken) {
    return { ok: false, code: "no_cart_token",
      message: opened.errorMessage ?? "the store did not issue a cart token, so no session can be opened against it" };
  }

  let cartToken: string | null = opened.cartToken;
  let cart: Record<string, unknown> | null = opened.cart;
  for (const item of items) {
    const res = await callStoreApi(ctx.storeUrl, {
      path: "/cart/add-item", body: { id: item.id, quantity: item.quantity },
      ...(cartToken ? { cartToken } : {}),
    }, ctx.fetchImpl);
    if (!res.ok || !res.cart) {
      // The store's own words: "not enough stock", "product not purchasable".
      return { ok: false, code: "store_rejected_item", message: res.errorMessage ?? "the store rejected this item" };
    }
    cartToken = res.cartToken ?? cartToken;
    cart = res.cart;
  }
  if (!cart || !cartToken) {
    return { ok: false, code: "no_cart_token", message: "the store did not return a Cart-Token, so this cart cannot be referred to again" };
  }

  const address = asRecord(asRecord(payload.fulfillment_details).shipping_address);
  if (Object.keys(address).length > 0) {
    const res = await callStoreApi(ctx.storeUrl, {
      path: "/cart/update-customer", body: { shipping_address: address }, cartToken,
    }, ctx.fetchImpl);
    if (!res.ok || !res.cart) return { ok: false, code: "address_rejected", message: res.errorMessage ?? "the store rejected the shipping address" };
    cart = res.cart;
  }
  return finish(ctx, cart, cartToken);
}

/** GET /checkout_sessions/{id} */
export async function getCheckoutSession(
  ctx: QuoteContext, _meta: AcpMeta, sessionId: string,
): Promise<QuoteResult> {
  const cartToken = decodeSessionId(sessionId);
  if (!cartToken) return { ok: false, code: "session_not_found", message: `not a checkout session id: ${sessionId}` };
  const res = await callStoreApi(ctx.storeUrl, { path: "/cart", cartToken }, ctx.fetchImpl);
  if (!res.ok || !res.cart) {
    // A cart token outlives nothing in particular and the store is the only
    // thing that knows whether it still resolves, so its answer is the answer.
    return { ok: false, code: "session_not_found", message: res.errorMessage ?? "this session no longer resolves to a cart" };
  }
  return finish(ctx, res.cart, cartToken);
}

/** POST /checkout_sessions/{id} — items, address, or the chosen shipping option. */
export async function updateCheckoutSession(
  ctx: QuoteContext, _meta: AcpMeta, sessionId: string, payload: Record<string, unknown>,
): Promise<QuoteResult> {
  const cartToken = decodeSessionId(sessionId);
  if (!cartToken) return { ok: false, code: "session_not_found", message: `not a checkout session id: ${sessionId}` };

  let cart: Record<string, unknown> | null = null;

  for (const item of itemsFromPayload(payload)) {
    const res = await callStoreApi(ctx.storeUrl, {
      path: "/cart/add-item", body: { id: item.id, quantity: item.quantity }, cartToken,
    }, ctx.fetchImpl);
    if (!res.ok || !res.cart) return { ok: false, code: "store_rejected_item", message: res.errorMessage ?? "the store rejected this item" };
    cart = res.cart;
  }

  const address = asRecord(asRecord(payload.fulfillment_details).shipping_address);
  if (Object.keys(address).length > 0) {
    const res = await callStoreApi(ctx.storeUrl, {
      path: "/cart/update-customer", body: { shipping_address: address }, cartToken,
    }, ctx.fetchImpl);
    if (!res.ok || !res.cart) return { ok: false, code: "address_rejected", message: res.errorMessage ?? "the store rejected the shipping address" };
    cart = res.cart;
  }

  const chosen = asArray(payload.selected_fulfillment_option_ids).map(String).filter(Boolean);
  if (chosen.length > 0) {
    // Selecting a rate needs the package it belongs to, and only the cart
    // knows that pairing — so the current cart is read first rather than the
    // package id being asked of the agent, which ACP never gives it.
    const current = cart ?? (await callStoreApi(ctx.storeUrl, { path: "/cart", cartToken }, ctx.fetchImpl)).cart;
    if (!current) return { ok: false, code: "session_not_found", message: "this session no longer resolves to a cart" };
    for (const rateId of chosen) {
      const packageId = findPackageForRate(current, rateId);
      if (packageId === null) {
        return { ok: false, code: "unknown_fulfillment_option",
          message: `no shipping option '${rateId}' is offered for this cart — read fulfillment_options and choose one of those ids` };
      }
      const res = await callStoreApi(ctx.storeUrl, {
        path: "/cart/select-shipping-rate", body: { package_id: packageId, rate_id: rateId }, cartToken,
      }, ctx.fetchImpl);
      if (!res.ok || !res.cart) return { ok: false, code: "rate_rejected", message: res.errorMessage ?? "the store rejected that shipping option" };
      cart = res.cart;
    }
  }

  if (!cart) {
    const res = await callStoreApi(ctx.storeUrl, { path: "/cart", cartToken }, ctx.fetchImpl);
    if (!res.ok || !res.cart) return { ok: false, code: "session_not_found", message: res.errorMessage ?? "this session no longer resolves to a cart" };
    cart = res.cart;
  }
  return finish(ctx, cart, cartToken);
}

export function findPackageForRate(cart: Record<string, unknown>, rateId: string): number | string | null {
  for (const raw of asArray(cart.shipping_rates)) {
    const pkg = asRecord(raw);
    for (const rate of asArray(pkg.shipping_rates)) {
      if (String(asRecord(rate).rate_id ?? "") === rateId) {
        const id = pkg.package_id;
        return typeof id === "number" || typeof id === "string" ? id : 0;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** ACP's discovery document, listing only what is actually implemented.
 *
 * `services` is the field an agent reads to decide what it can attempt, so
 * listing a service that answers "unsupported" wastes a call and, worse,
 * teaches the agent that this seller's discovery cannot be trusted. Checkout
 * completion, cancellation and orders are absent because they are absent.
 *
 * Its natural home is `/.well-known/acp.json` on the seller's own domain. This
 * service is not that domain — it is a surface in front of one — so the
 * document is served next to the endpoint it describes, and the merchant
 * points at it from their own well-known path if they want REST agents to
 * find it without being told.
 */
export function discoveryDocument(mcpEndpoint: string): Record<string, unknown> {
  return {
    protocol: {
      name: "acp",
      version: ACP_API_VERSION,
      supported_versions: [ACP_API_VERSION],
    },
    // No REST binding is served, so there is no base URL to append paths to.
    // The MCP endpoint is the whole of it.
    api_base_url: mcpEndpoint,
    transports: ["mcp"],
    capabilities: {
      services: ["checkout.create", "checkout.get", "checkout.update"],
      extensions: [],
      intervention_types: [],
    },
  };
}
