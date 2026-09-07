// The paid boundary of this product is the free plan's offer limit. Adding a
// second request shape to /mcp/{store} is only safe if it goes through the
// same enforcement — a JSON-RPC path calling runTool() directly would be a way
// around the limit, not a convenience. These tests pin that.
import test from "node:test";
import assert from "node:assert/strict";
import { callStoreTool, storeMcpTools } from "../src/app.ts";
import { PLAN_OFFER_LIMITS } from "../src/core/appStore.ts";
import type { ServiceConfig } from "../src/service.ts";
import { TOOL_NAME } from "../src/mcp.ts";

/** Selected by name, not position. These tests took the first tool in the
 * list, so adding the ACP checkout tools alongside the catalogue one silently
 * pointed every plan-limit assertion at the wrong tool. */
function catalogueTool(store: { plan: Parameters<typeof storeMcpTools>[0]["plan"] }, config: ServiceConfig) {
  const tool = storeMcpTools(store, config).find(t => t.name === TOOL_NAME);
  assert.ok(tool, "the catalogue tool must stay on the list");
  return tool;
}

/** A stand-in store whose catalogue is bigger than the free limit. */
const CATALOGUE = Array.from({ length: PLAN_OFFER_LIMITS.free + 10 }, (_, i) => ({
  id: i + 1, name: `Product ${i + 1}`, price: "10.00",
}));

function stubConfig(): ServiceConfig {
  return {
    storeUrl: "https://shop.example.com",
    consumerKey: "ck", consumerSecret: "cs",
    cartSigningSecret: "s".repeat(32), publicBaseUrl: "https://app.example.com",
  } as unknown as ServiceConfig;
}

/** Intercepts the WooCommerce REST calls runTool() makes. */
function stubFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/wp-json/wc/v3/products")) {
      return new Response(JSON.stringify(CATALOGUE), {
        status: 200, headers: { "content-type": "application/json", "x-wp-total": String(CATALOGUE.length) },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("the free plan's offer limit applies to a JSON-RPC tools/call, not just the older shape", async () => {
  stubFetch();
  const tool = catalogueTool({ plan: "free" }, stubConfig());
  const out = await tool.run({ action: "get_feed" });
  assert.equal(out.ok, true);
  const payload = JSON.parse(out.text) as { offers: unknown[]; truncated: boolean };
  assert.equal(payload.offers.length, PLAN_OFFER_LIMITS.free);
  assert.equal(payload.truncated, true);
});

test("a paid plan is not truncated", async () => {
  stubFetch();
  const tool = catalogueTool({ plan: "pro" }, stubConfig());
  const out = await tool.run({ action: "get_feed" });
  const payload = JSON.parse((out as { text: string }).text) as { offers: unknown[]; truncated: boolean };
  assert.equal(payload.offers.length, CATALOGUE.length);
  assert.equal(payload.truncated, false);
});

// A product outside the free plan's window must stay out of reach through
// every shape, or the limit is decorative.
test("a product beyond the free window cannot be fetched over JSON-RPC either", async () => {
  stubFetch();
  const beyond = PLAN_OFFER_LIMITS.free + 5;
  const tool = catalogueTool({ plan: "free" }, stubConfig());
  const out = await tool.run({ action: "get_offer", product_id: beyond });
  assert.equal(out.ok, false);
  assert.match(out.text, /outside the free plan/);

  // And the same call through the shared implementation reports it as a 403,
  // which is what the older shape returns.
  const direct = await callStoreTool({ plan: "free" }, stubConfig(), { action: "get_offer", product_id: beyond });
  assert.equal(direct.ok, false);
  assert.equal((direct as { status: number }).status, 403);
});

test("a plan limit reaches the model as an answer, not a crash", async () => {
  stubFetch();
  const tool = catalogueTool({ plan: "free" }, stubConfig());
  const out = await tool.run({ action: "get_offer", product_id: PLAN_OFFER_LIMITS.free + 1 });
  // ok:false becomes isError on the wire — the model sees why and can say so.
  assert.equal(out.ok, false);
  assert.ok(out.text.length > 0);
});

test("the advertised schema matches the actions the service really dispatches", () => {
  const tool = catalogueTool({ plan: "free" }, stubConfig());
  const actions = (tool.inputSchema as { properties: { action: { enum: string[] } } }).properties.action.enum;
  assert.deepEqual([...actions].sort(),
    ["create_cart_link", "get_feed", "get_offer", "search_products", "verify_cart_link"]);
});
