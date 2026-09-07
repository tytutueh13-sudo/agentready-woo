// ACP checkout sessions, quote half. The value here is the landed total — tax
// and shipping computed by the merchant's own store, which an agent cannot
// work out from a catalogue. The tests that matter most are the ones about
// what this must NOT claim.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  createCheckoutSession, getCheckoutSession, updateCheckoutSession,
  encodeSessionId, decodeSessionId, totalsFromCart, fulfillmentOptionsFromCart,
  findPackageForRate, type QuoteContext, type FetchLike,
} from "../src/core/acpQuote.ts";

const STORE = "https://shop.example";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.cart-token-value";

/** A Store API cart, in the shape WooCommerce actually returns: money as
 * strings of minor units, shipping rates nested one level inside packages. */
function cart(opts: {
  items?: Array<{ id: number; key: string; qty: number; subtotal: string; total: string; tax: string }>;
  totals?: Record<string, string>;
  rates?: Array<{ rate_id: string; name: string; price: string; taxes: string; selected?: boolean; delivery_time?: string }>;
  errors?: Array<{ code: string; message: string }>;
} = {}): Record<string, unknown> {
  const items = opts.items ?? [{ id: 42, key: "k1", qty: 2, subtotal: "4000", total: "4000", tax: "400" }];
  return {
    items: items.map(i => ({
      id: i.id, key: i.key, quantity: i.qty,
      totals: { line_subtotal: i.subtotal, line_total: i.total, line_total_tax: i.tax },
    })),
    totals: {
      currency_code: "USD", currency_minor_unit: 2,
      total_items: "4000", total_items_tax: "400", total_discount: "0", total_fees: "0",
      total_shipping: "0", total_tax: "400", total_price: "4400",
      ...opts.totals,
    },
    shipping_rates: opts.rates
      ? [{ package_id: 0, shipping_rates: opts.rates.map(r => ({ ...r, selected: r.selected ?? false })) }]
      : [],
    errors: opts.errors ?? [],
  };
}

interface Call { path: string; body: unknown; token: string | null }

/** A store that enforces the rule the real one does: a POST without a cart
 * token is refused for want of a nonce. A fixture that accepts one anyway let
 * the whole create path pass in tests and fail on the first live call. */
function fakeStore(
  handler: (call: Call) => { status?: number; json: unknown },
  opts: { requireCartToken?: boolean } = {},
): { fetchImpl: FetchLike; calls: Call[] } {
  const requireToken = opts.requireCartToken ?? true;
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const path = String(url).replace(`${STORE}/wp-json/wc/store/v1`, "");
    const headers = new Headers(init?.headers);
    const call: Call = {
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      token: headers.get("cart-token"),
    };
    calls.push(call);
    if (requireToken && call.body !== undefined && !call.token) {
      return new Response(JSON.stringify({
        code: "woocommerce_rest_missing_nonce",
        message: "Missing the Nonce header. This endpoint requires a valid nonce.",
      }), { status: 401, headers: { "content-type": "application/json", "cart-token": TOKEN } });
    }
    const out = handler(call);
    return new Response(JSON.stringify(out.json), {
      status: out.status ?? 200,
      headers: { "content-type": "application/json", "cart-token": TOKEN },
    });
  };
  return { fetchImpl, calls };
}

const ctxWith = (fetchImpl: FetchLike, extra: Partial<QuoteContext> = {}): QuoteContext =>
  ({ storeUrl: STORE, fetchImpl, now: () => new Date("2026-09-01T00:00:00Z"), ...extra });

test("a session id round-trips the cart token and nothing else", () => {
  const id = encodeSessionId(TOKEN);
  assert.ok(id.startsWith("cs_"));
  assert.equal(decodeSessionId(id), TOKEN);
  for (const bad of ["", "cs_", "nope", "cs_!!!!"]) {
    assert.equal(decodeSessionId(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test("create returns the store's own landed total, in integer minor units", async () => {
  const { fetchImpl, calls } = fakeStore(() => ({ json: cart() }));
  const out = await createCheckoutSession(ctxWith(fetchImpl), {}, { items: [{ id: 42, quantity: 2 }] });

  assert.ok(out.ok, JSON.stringify(out));
  if (!out.ok) return;
  assert.equal(out.session.currency, "USD");
  const byType = Object.fromEntries(out.session.totals.map(t => [t.type, t.amount]));
  assert.deepEqual(byType, { items_base_amount: 4000, tax: 400, total: 4400 });
  for (const t of out.session.totals) {
    assert.equal(Number.isInteger(t.amount), true, `${t.type} must be an integer of minor units`);
  }
  // The opening GET is what obtains the cart token every later call needs.
  assert.deepEqual(calls.map(c => c.path), ["/cart", "/cart/add-item"]);
  assert.deepEqual(calls[1].body, { id: 42, quantity: 2 });
});

// Everything this refuses to claim.
test("a quote never says stock is held, and never says it is ready for payment", async () => {
  const { fetchImpl } = fakeStore(() => ({ json: cart({ rates: [{ rate_id: "flat", name: "Flat", price: "500", taxes: "0", selected: true }] }) }));
  const out = await createCheckoutSession(ctxWith(fetchImpl), {}, { items: [{ id: 42, quantity: 1 }] });
  assert.ok(out.ok);
  if (!out.ok) return;

  const raw = out.session as unknown as Record<string, unknown>;
  // `quote_id`/`quote_expires_at` are ACP's way of saying stock is reserved.
  // Nothing here reserves any: WooCommerce holds stock only through
  // ReserveStock::reserve_stock_for_order(), which has no REST route.
  assert.equal(raw.quote_id, undefined, "must not claim a reservation");
  assert.equal(raw.quote_expires_at, undefined, "must not claim a reservation window");
  assert.notEqual(out.session.status, "ready_for_payment");
  assert.equal(out.session.status, "not_ready_for_payment");
  // And the session says so out loud, since an agent reads messages.
  assert.ok(out.session.messages.some(m => /completes the purchase/i.test(m.content)));
  assert.deepEqual(out.session.capabilities.payment, { handlers: [] });
});

test("shipping is absent from the totals until a rate is actually chosen", () => {
  const unchosen = totalsFromCart(cart({ rates: [{ rate_id: "flat", name: "Flat", price: "500", taxes: "0" }] }));
  assert.equal(unchosen.find(t => t.type === "fulfillment"), undefined,
    "a 0 shipping line before selection reads as free delivery");

  const chosen = totalsFromCart(cart({
    rates: [{ rate_id: "flat", name: "Flat", price: "500", taxes: "0", selected: true }],
    totals: { total_shipping: "500", total_price: "4900" },
  }));
  assert.equal(chosen.find(t => t.type === "fulfillment")?.amount, 500);
  assert.equal(chosen.find(t => t.type === "total")?.amount, 4900);
});

// WooCommerce's `delivery_time` is free text a plugin may set to anything.
// ACP's delivery fields are RFC 3339 timestamps. Guessing between the two
// would put a date in front of a buyer who plans around it.
test("a free-text delivery estimate never becomes a timestamp", () => {
  const options = fulfillmentOptionsFromCart(cart({
    rates: [{ rate_id: "flat", name: "Standard", price: "500", taxes: "50", delivery_time: "2-3 business days" }],
  }));
  assert.equal(options.length, 1);
  assert.equal(options[0].description, "2-3 business days");
  assert.equal(options[0].earliest_delivery_time, undefined);
  assert.equal(options[0].latest_delivery_time, undefined);
  // Price and its tax are one number to the buyer.
  assert.equal(options[0].totals[0].amount, 550);
});

test("the store's own refusal is what the agent is told", async () => {
  const { fetchImpl } = fakeStore(() => ({
    status: 400,
    json: { code: "woocommerce_rest_product_partially_out_of_stock", message: "Sorry, we only have 2 of “Blue Mug” in stock." },
  }));
  const out = await createCheckoutSession(ctxWith(fetchImpl), {}, { items: [{ id: 42, quantity: 5 }] });
  assert.equal(out.ok, false);
  if (out.ok) return;
  // Not flattened into "could not add item": the count is the useful part.
  assert.match(out.message, /only have 2/);
});

test("an address is applied on create and the recalculated cart is what comes back", async () => {
  const { fetchImpl, calls } = fakeStore(call =>
    call.path === "/cart/update-customer"
      ? { json: cart({ rates: [{ rate_id: "flat", name: "Flat", price: "500", taxes: "0" }], totals: { total_tax: "700", total_price: "4700" } }) }
      : { json: cart() });

  const out = await createCheckoutSession(ctxWith(fetchImpl), {}, {
    items: [{ id: 42, quantity: 2 }],
    fulfillment_details: { shipping_address: { country: "US", state: "CA", postcode: "94103", city: "San Francisco" } },
  });
  assert.ok(out.ok, JSON.stringify(out));
  if (!out.ok) return;
  assert.deepEqual(calls.map(c => c.path), ["/cart", "/cart/add-item", "/cart/update-customer"]);
  assert.equal(calls[2].token, TOKEN, "later calls must reuse the cart token");
  // Tax moved because the destination did — the whole point of the call.
  assert.equal(out.session.totals.find(t => t.type === "tax")?.amount, 700);
  assert.equal(out.session.fulfillment_options.length, 1);
});

test("choosing a shipping option does not make the agent supply a package id", async () => {
  const withRates = cart({ rates: [{ rate_id: "flat_rate:3", name: "Flat", price: "500", taxes: "0" }] });
  const { fetchImpl, calls } = fakeStore(call =>
    call.path === "/cart/select-shipping-rate"
      ? { json: cart({ rates: [{ rate_id: "flat_rate:3", name: "Flat", price: "500", taxes: "0", selected: true }], totals: { total_shipping: "500", total_price: "4900" } }) }
      : { json: withRates });

  const out = await updateCheckoutSession(ctxWith(fetchImpl), {}, encodeSessionId(TOKEN), {
    selected_fulfillment_option_ids: ["flat_rate:3"],
  });
  assert.ok(out.ok, JSON.stringify(out));
  if (!out.ok) return;
  // ACP gives an agent a fulfillment option id and never a package id, so the
  // pairing is looked up here rather than demanded.
  const select = calls.find(c => c.path === "/cart/select-shipping-rate");
  assert.deepEqual(select?.body, { package_id: 0, rate_id: "flat_rate:3" });
  assert.deepEqual(out.session.selected_fulfillment_options, [{ fulfillment_option_id: "flat_rate:3" }]);
  assert.equal(out.session.totals.find(t => t.type === "total")?.amount, 4900);
});

test("an option the store does not offer is refused by name, with the fix", async () => {
  const { fetchImpl } = fakeStore(() => ({ json: cart({ rates: [{ rate_id: "flat_rate:3", name: "Flat", price: "500", taxes: "0" }] }) }));
  const out = await updateCheckoutSession(ctxWith(fetchImpl), {}, encodeSessionId(TOKEN), {
    selected_fulfillment_option_ids: ["express_overnight"],
  });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.code, "unknown_fulfillment_option");
  assert.match(out.message, /express_overnight/);
  assert.match(out.message, /fulfillment_options/, "says where the valid ids are");
});

test("get reads the same session back, and a dead cart says so", async () => {
  const live = fakeStore(() => ({ json: cart() }));
  const ok = await getCheckoutSession(ctxWith(live.fetchImpl), {}, encodeSessionId(TOKEN));
  assert.ok(ok.ok);
  if (ok.ok) assert.equal(ok.session.id, encodeSessionId(TOKEN));
  assert.deepEqual(live.calls.map(c => c.path), ["/cart"]);
  assert.equal(live.calls[0].token, TOKEN);

  const dead = fakeStore(() => ({ status: 403, json: { message: "Cart token is invalid." } }));
  const gone = await getCheckoutSession(ctxWith(dead.fetchImpl), {}, encodeSessionId(TOKEN));
  assert.equal(gone.ok, false);
  if (!gone.ok) assert.equal(gone.code, "session_not_found");
});

// A single product can be handed to a browser with WooCommerce's own
// add-to-cart URL. Several cannot — there is no core URL that rebuilds a
// multi-item cart — so the quote says that rather than linking somewhere that
// silently drops items.
test("a multi-item quote admits it cannot hand the whole cart over", async () => {
  const twoItems = cart({
    items: [
      { id: 42, key: "k1", qty: 1, subtotal: "2000", total: "2000", tax: "200" },
      { id: 43, key: "k2", qty: 1, subtotal: "2000", total: "2000", tax: "200" },
    ],
  });
  const { fetchImpl } = fakeStore(() => ({ json: twoItems }));
  const out = await createCheckoutSession(
    ctxWith(fetchImpl, { resolveContinueUrl: async items => (items.length === 1 ? "https://shop.example/cart?x=1" : null) }),
    {}, { items: [{ id: 42, quantity: 1 }, { id: 43, quantity: 1 }] });

  assert.ok(out.ok);
  if (!out.ok) return;
  assert.equal(out.session.continue_url, undefined);
  const warning = out.session.messages.find(m => m.code === "multi_item_handoff");
  assert.ok(warning, "must warn rather than link somewhere lossy");
  assert.equal(warning?.type, "warning");
});

test("a broken hand-off link does not throw away the prices that were asked for", async () => {
  const { fetchImpl } = fakeStore(() => ({ json: cart() }));
  const out = await createCheckoutSession(
    ctxWith(fetchImpl, { resolveContinueUrl: async () => { throw new Error("signing key missing"); } }),
    {}, { items: [{ id: 42, quantity: 2 }] });
  assert.ok(out.ok, "the quote survives a failed link");
  if (out.ok) assert.equal(out.session.totals.find(t => t.type === "total")?.amount, 4400);
});

test("items are accepted in ACP's nested shape and the flat one alike", async () => {
  const { fetchImpl, calls } = fakeStore(() => ({ json: cart() }));
  await createCheckoutSession(ctxWith(fetchImpl), {}, { items: [{ item: { id: 7, quantity: 3 } }] });
  assert.deepEqual(calls[1].body, { id: 7, quantity: 3 });

  const bad = fakeStore(() => ({ json: cart() }));
  const out = await createCheckoutSession(ctxWith(bad.fetchImpl), {}, { items: [{ id: 0, quantity: -1 }] });
  assert.equal(out.ok, false);
  assert.equal(bad.calls.length, 0, "nothing malformed reaches the store");
});

test("findPackageForRate answers null rather than guessing a package", () => {
  const c = cart({ rates: [{ rate_id: "a", name: "A", price: "1", taxes: "0" }] });
  assert.equal(findPackageForRate(c, "a"), 0);
  assert.equal(findPackageForRate(c, "b"), null);
});

// Discovery is the field an agent reads to decide what to attempt. Listing a
// service that answers "unsupported" wastes a call and teaches the agent that
// this seller's discovery cannot be trusted.
test("discovery advertises exactly the three services that exist", async () => {
  const { discoveryDocument, ACP_API_VERSION } = await import("../src/core/acpQuote.ts");
  const doc = discoveryDocument("https://app.example/mcp/store_1");

  assert.deepEqual(doc.protocol, { name: "acp", version: ACP_API_VERSION, supported_versions: [ACP_API_VERSION] });
  assert.deepEqual(doc.transports, ["mcp"]);
  const services = (doc.capabilities as Record<string, unknown>).services as string[];
  assert.deepEqual(services, ["checkout.create", "checkout.get", "checkout.update"]);
  for (const absent of ["checkout.complete", "checkout.cancel", "orders"]) {
    assert.ok(!services.includes(absent), `${absent} is not implemented and must not be advertised`);
  }
});

test("the tool list offers the three ACP names and withholds the two it cannot honour", async () => {
  const { storeMcpTools } = await import("../src/app.ts");
  const names = storeMcpTools({ plan: "free" }, {
    storeUrl: STORE, consumerKey: "ck", consumerSecret: "cs",
    cartSigningSecret: "s".repeat(32), publicBaseUrl: "https://app.example",
  }).map(t => t.name);

  for (const present of ["create_checkout_session", "get_checkout_session", "update_checkout_session"]) {
    assert.ok(names.includes(present), `missing ${present}`);
  }
  // Offered-and-refusing is a dead end; absent is a fact an agent can plan
  // around. Neither reserves stock nor takes payment, so neither is offered.
  for (const absent of ["complete_checkout_session", "cancel_checkout_session"]) {
    assert.ok(!names.includes(absent), `${absent} must not be advertised`);
  }
});

// Captured from a live WooCommerce store (woocommerce.com), not written from
// the documentation. The documentation describes total_shipping as a money
// string; a real cart that needs no shipping sends null. A fixture built from
// prose would not have contained that, and the mapper would have been correct
// only by accident.
const OBSERVED_DIGITAL_CART = {
  items: [{
    id: 18734006846727, key: "obs1", quantity: 1,
    totals: {
      line_subtotal: "4900", line_subtotal_tax: "0",
      line_total: "4900", line_total_tax: "0",
      currency_code: "USD", currency_minor_unit: 2,
    },
  }],
  totals: {
    total_items: "4900", total_items_tax: "0",
    total_fees: "0", total_fees_tax: "0",
    total_discount: "0", total_discount_tax: "0",
    total_shipping: null, total_shipping_tax: null,
    total_price: "4900", total_tax: "0", tax_lines: [],
    currency_code: "USD", currency_minor_unit: 2,
  },
  needs_shipping: false,
  shipping_rates: [],
  errors: [],
} as unknown as Record<string, unknown>;

test("a real digital cart, whose shipping total is null rather than zero", () => {
  const totals = totalsFromCart(OBSERVED_DIGITAL_CART);
  const byType = Object.fromEntries(totals.map(t => [t.type, t.amount]));
  assert.deepEqual(byType, { items_base_amount: 4900, tax: 0, total: 4900 });
  // Nothing ships, so there is no shipping line to show — and null must not
  // become a displayed zero, which reads as "delivery included".
  assert.equal(totals.find(t => t.type === "fulfillment"), undefined);
  assert.equal(fulfillmentOptionsFromCart(OBSERVED_DIGITAL_CART).length, 0);
});

test("the observed cart maps to a session an agent can read", async () => {
  const { fetchImpl } = fakeStore(() => ({ json: OBSERVED_DIGITAL_CART }));
  const out = await createCheckoutSession(ctxWith(fetchImpl), {}, { items: [{ id: 18734006846727, quantity: 1 }] });
  assert.ok(out.ok, JSON.stringify(out));
  if (!out.ok) return;
  assert.equal(out.session.currency, "USD");
  assert.equal(out.session.line_items.length, 1);
  assert.deepEqual(out.session.line_items[0], {
    id: "obs1", item: { id: "18734006846727", quantity: 1 },
    base_amount: 4900, discount: 0, subtotal: 4900, tax: 0, total: 4900,
  });
  assert.equal(out.session.status, "not_ready_for_payment");
});

// The Store API's POST endpoints are documented as needing "a Nonce Token or a
// Cart Token", which reads like a choice. It is not one: there is no cart
// token until the store issues a cart, and a nonce belongs to a browser
// session. Every mocked test passed while the first live call was refused.
test("a session opens a cart before it puts anything in one", async () => {
  const { fetchImpl, calls } = fakeStore(() => ({ json: cart() }));
  const out = await createCheckoutSession(ctxWith(fetchImpl), {}, { items: [{ id: 42, quantity: 1 }] });

  assert.ok(out.ok, JSON.stringify(out));
  assert.equal(calls[0].path, "/cart");
  assert.equal(calls[0].body, undefined, "opening a cart is a GET");
  for (const call of calls.slice(1)) {
    assert.equal(call.token, TOKEN, `${call.path} must carry the cart token`);
  }
});

test("a store that issues no cart token is refused cleanly, not part-way through", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response(JSON.stringify({ message: "carts are disabled" }), { status: 403 });
  const out = await createCheckoutSession(ctxWith(fetchImpl), {}, { items: [{ id: 42, quantity: 1 }] });
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.code, "no_cart_token");
});
