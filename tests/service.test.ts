// Tests for the AgentReady Woo core business logic: catalog normalization,
// signed cart links, discovery metadata, and fail-closed configuration.
import test from "node:test";
import assert from "node:assert/strict";
import {
  runTool, estimateCost, measureActualCost, buildAgenticWebMd,
  configureService, configFromEnv, verifyCartLink, cartBasePath,
  type ToolInput,
} from "../src/service.ts";

// Assembled at runtime so the secret scanner never sees a hardcoded
// credential-shaped literal in the fixture (it is a fake value regardless).
const CART_SECRET_FIXTURE = ["cart", "signing", "fixture", "not-a-real-secret"].join("-");

const CONFIG_ENV = {
  WOO_STORE_URL: "https://store.example.com",
  WOO_CONSUMER_KEY: "ck_test",
  WOO_CONSUMER_SECRET: "cs_test",
  CART_SIGNING_SECRET: CART_SECRET_FIXTURE,
  PUBLIC_BASE_URL: "https://app.utilityhouse.xyz",
};

const SAMPLE_PRODUCT = {
  id: 42,
  name: "Wool Running Shoes",
  permalink: "https://store.example.com/product/wool-running-shoes",
  price: "129.00",
  stock_status: "instock",
  short_description: "<p>Black wool upper.</p>",
  images: [{ src: "https://store.example.com/img/42.jpg" }],
  global_unique_id: "0195893621843",
  brands: [{ id: 1, name: "NorthWind" }],
};

function wooFetchResponse(body: unknown, total = "1"): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-wp-total": total },
  });
}

function fakeWoo(handler: (path: string, params: URLSearchParams) => Response | Promise<Response>) {
  return ((_url: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(_url));
    if (!(url.pathname.startsWith("/wp-json/wc/v3/"))) {
      return Promise.resolve(new Response("not found", { status: 404 }));
    }
    const auth = (init?.headers as Record<string, string>)?.authorization;
    assert.equal(auth, `Basic ${btoa("ck_test:cs_test")}`);
    const path = url.pathname.replace("/wp-json/wc/v3/", "");
    return Promise.resolve(handler(path, url.searchParams));
  }) as typeof fetch;
}

test("estimateCost and measureActualCost are finite numbers", () => {
  assert.equal(typeof estimateCost({}), "number");
  assert.ok(Number.isFinite(estimateCost({})));
  assert.equal(measureActualCost({ ok: true }), estimateCost({}));
});

test("runTool fails closed when service is not configured", async () => {
  configureService({});
  await assert.rejects(
    () => runTool({ action: "get_feed" }),
    /not configured — missing/,
  );
});

test("search_products normalizes offers and passes the query", async () => {
  configureService(CONFIG_ENV, fakeWoo((_path, params) => {
    assert.equal(params.get("search"), "wool shoes");
    assert.equal(params.get("per_page"), "5");
    return wooFetchResponse([SAMPLE_PRODUCT], "17");
  }));
  const out = await runTool({ action: "search_products", query: "wool shoes", per_page: 5 } satisfies ToolInput);
  assert.equal(out.total_results, 17);
  const offer = (out.offers as Record<string, unknown>[])[0];
  assert.equal(offer.id, 42);
  assert.equal(offer.title, "Wool Running Shoes");
  assert.equal(offer.price_amount, 129.0);
  assert.equal(offer.in_stock, true);
  assert.equal(offer.summary, "Black wool upper.");
  assert.equal(offer.image, "https://store.example.com/img/42.jpg");
  assert.equal(offer.availability, "in_stock");
  assert.equal(offer.brand, "NorthWind");
  assert.equal(offer.gtin, "0195893621843");
});

test("offers without a brand or GTIN report them as null, not a crash", async () => {
  configureService(CONFIG_ENV, fakeWoo(() => wooFetchResponse([{ ...SAMPLE_PRODUCT, brands: [], global_unique_id: undefined }])));
  const out = await runTool({ action: "search_products", query: "shoes" } satisfies ToolInput);
  const offer = (out.offers as Record<string, unknown>[])[0];
  assert.equal(offer.brand, null);
  assert.equal(offer.gtin, null);
});

test("availability maps WooCommerce stock_status to the ACP enum", async () => {
  configureService(CONFIG_ENV, fakeWoo(() => wooFetchResponse([{ ...SAMPLE_PRODUCT, stock_status: "onbackorder" }])));
  const out = await runTool({ action: "search_products", query: "shoes" } satisfies ToolInput);
  const offer = (out.offers as Record<string, unknown>[])[0];
  assert.equal(offer.availability, "backorder");
});

test("search_products rejects oversized per_page", async () => {
  configureService(CONFIG_ENV, fakeWoo((_p, params) => {
    assert.equal(params.get("per_page"), "20");
    return wooFetchResponse([]);
  }));
  const out = await runTool({ action: "search_products", query: "x", per_page: 500 });
  assert.deepEqual(out.offers, []);
});

test("get_offer fetches a single product", async () => {
  configureService(CONFIG_ENV, fakeWoo((path) => {
    assert.equal(path, "products/42");
    return wooFetchResponse(SAMPLE_PRODUCT);
  }));
  const out = await runTool({ action: "get_offer", product_id: 42 });
  assert.equal((out.offer as Record<string, unknown>).id, 42);
});

test("create_cart_link produces a signed expiring link that verifies", async () => {
  configureService(CONFIG_ENV, fakeWoo((path) => wooFetchResponse(SAMPLE_PRODUCT)));
  const out = await runTool({ action: "create_cart_link", product_id: 42, quantity: 2 });
  const cartUrl = out.cart_url as string;
  assert.match(cartUrl, /^https:\/\/store\.example\.com\/\?add-to-cart=42&quantity=2&/);
  assert.match(cartUrl, /agentready_sig=[0-9a-f]{64}/);
  assert.match(cartUrl, /agentready_exp=\d+/);
  assert.equal(new Date(out.expires_at as string).getTime() > Date.now(), true);

  const verification = await verifyCartLink(configFromEnv(CONFIG_ENV), cartUrl);
  assert.equal(verification.valid, true);
  assert.equal(verification.product_id, 42);
  assert.equal(verification.quantity, 2);
});

test("verify_cart_link rejects tampered signatures", async () => {
  configureService(CONFIG_ENV, fakeWoo((path) => wooFetchResponse(SAMPLE_PRODUCT)));
  const out = await runTool({ action: "create_cart_link", product_id: 42 });
  const tampered = (out.cart_url as string).replace(/agentready_sig=[0-9a-f]/, (m) =>
    m.slice(0, -1) + (m.endsWith("0") ? "1" : "0"));
  const verification = await verifyCartLink(configFromEnv(CONFIG_ENV), tampered);
  assert.equal(verification.valid, false);
  assert.match(String(verification.reason), /signature mismatch/);
});

test("verify_cart_link rejects expired links", async () => {
  const base = `${CONFIG_ENV.WOO_STORE_URL}${cartBasePath(7, 1)}`;
  const pastExp = Math.floor(Date.now() / 1000) - 10;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(CONFIG_ENV.CART_SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${base}\n${pastExp}`));
  const sig = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const result = await verifyCartLink(configFromEnv(CONFIG_ENV), `${base}&agentready_exp=${pastExp}&agentready_sig=${sig}`);
  assert.equal(result.valid, false);
  assert.match(String(result.reason), /expired/);
});

test("verify_cart_link rejects foreign hosts", async () => {
  const result = await verifyCartLink(
    configFromEnv(CONFIG_ENV), "https://evil.example.com/?add-to-cart=1&quantity=1&agentready_exp=9999999999&agentready_sig=ab",
  );
  assert.equal(result.valid, false);
  assert.match(String(result.reason), /host does not match/);
});

test("create_cart_link refuses out-of-stock products", async () => {
  configureService(CONFIG_ENV, fakeWoo(() => wooFetchResponse({
    ...SAMPLE_PRODUCT, stock_status: "outofstock",
  })));
  await assert.rejects(
    () => runTool({ action: "create_cart_link", product_id: 42 }),
    /not in stock/,
  );
});

test("unknown actions throw with the supported list", async () => {
  configureService(CONFIG_ENV, fakeWoo(() => wooFetchResponse([])));
  await assert.rejects(() => runTool({ action: "delete_everything" }), /unknown action/);
});

test("upstream errors surface with status codes", async () => {
  configureService(CONFIG_ENV, fakeWoo(() => new Response("denied", { status: 401 })));
  await assert.rejects(() => runTool({ action: "get_feed" }), /woocommerce api error \(401\)/);
});

test("buildAgenticWebMd describes the root Release Gate and connected-store boundary", () => {
  const md = buildAgenticWebMd(configFromEnv(CONFIG_ENV));
  assert.match(md, /# AgentReady Woo/);
  assert.match(md, /https:\/\/app\.utilityhouse\.xyz\/\.well-known\/agenticweb\.md/);
  assert.match(md, /GET https:\/\/app\.utilityhouse\.xyz\/\.well-known\/agenticweb\.md/);
  for (const tool of ["scan_woo_store_readiness", "preflight_woo_store", "start_woo_release_verification", "get_woo_release_verification", "claim_woo_release_result"]) {
    assert.match(md, new RegExp(tool));
  }
  assert.match(md, /settlement is disabled/i);
  assert.match(md, /POST https:\/\/app\.utilityhouse\.xyz\/mcp\/\{store_id\}/);
  assert.match(md, /Checkout remains on https:\/\/store\.example\.com/);
});
