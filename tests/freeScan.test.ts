// The readiness scan is the front door: the homepage offers it free, and the
// paid tiers are what comes after. Over MCP it was answered 402 against
// `eip155:84532` — Base Sepolia — so every agent that found the tool was
// quoted a price in a currency it could not obtain. Not a paywall; a closed
// door with a price list on it.
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/core/memoryStore.ts";
import { RevenueGuard } from "../src/core/guard.ts";
import { MockPaymentProvider } from "../src/core/paymentProvider.ts";
import { handleMcpCall, TOOL_NAME } from "../src/mcp.ts";
import { handleApiCall } from "../src/api.ts";
import type { RevenueGuardConfig } from "../src/core/pricing.ts";
import type { ServiceConfig } from "../src/service.ts";

const PRODUCT_ID = "early-3426536d88daa242";

const CONFIG: RevenueGuardConfig = {
  minGrossMarginRatio: 0.70, minPriceMultiplier: 3.0,
  perRequestMaxCost: 0.50, dailyMaxCost: 20.0, monthlyMaxCost: 300.0,
  perUserDailyCost: 2.0, perProductDailyCost: 20.0,
  rateLimitWindowSeconds: 60, rateLimitMaxRequests: 30,
  circuitBreakerFailureThreshold: 3, circuitBreakerWindowSeconds: 60, circuitBreakerCooldownSeconds: 60,
  cacheDefaultTtlSeconds: 3600,
};

function guard(): RevenueGuard {
  return new RevenueGuard(new MemoryStore(), CONFIG, new MockPaymentProvider(), {});
}

/** A store whose catalogue answers without leaving the test. */
function stubStore(): ServiceConfig {
  return {
    storeUrl: "https://shop.example", consumerKey: "ck", consumerSecret: "cs",
    cartSigningSecret: "s".repeat(32), publicBaseUrl: "https://app.example",
  };
}

const realFetch = globalThis.fetch;
function withCatalogue<T>(run: () => Promise<T>): Promise<T> {
  globalThis.fetch = (async () => new Response(JSON.stringify([{ id: 1, name: "Mug", price: "10.00", status: "publish" }]), {
    status: 200, headers: { "content-type": "application/json", "x-wp-total": "1" },
  })) as typeof fetch;
  return run().finally(() => { globalThis.fetch = realFetch; });
}

test("at price zero the scan runs instead of demanding payment", async () => {
  const out = await withCatalogue(() => handleMcpCall(
    guard(), { tool: TOOL_NAME, input: { action: "get_feed" }, identity: "agent-1" },
    0, PRODUCT_ID, stubStore(),
  ));
  assert.equal(out.error, undefined, `expected a result, got ${out.error} at ${out.stage}`);
  assert.ok(out.result, "the scan must actually answer");
  assert.equal(out.accepts, undefined, "and quote no price");
});

test("the REST shape of the same tool is free on the same terms", async () => {
  const out = await withCatalogue(() => handleApiCall(
    guard(), { input: { action: "get_feed" }, identity: "agent-1" },
    0, PRODUCT_ID, stubStore(),
  ));
  assert.equal(out.status, 200, JSON.stringify(out.body));
});

// The guard refuses a zero price paired with a non-zero upstream cost, and it
// is right to — that pairing is a service giving away someone else's bill.
// This one genuinely costs nothing upstream: it reads the store being scanned.
test("a free call declares no upstream cost, which is why the guard allows it", async () => {
  const out = await withCatalogue(() => handleMcpCall(
    guard(), { tool: TOOL_NAME, input: { action: "get_feed" }, identity: "agent-2" },
    0, PRODUCT_ID, stubStore(),
  ));
  assert.notEqual(out.stage, "estimate_cost",
    "a zero price with a non-zero estimate is rejected here, and would be the whole bug back again");
});

test("a priced call still asks for payment, so the rail is intact", async () => {
  const out = await withCatalogue(() => handleMcpCall(
    guard(), { tool: TOOL_NAME, input: { action: "get_feed" }, identity: "agent-3" },
    0.05, PRODUCT_ID, stubStore(),
  ));
  assert.ok(out.error, "a priced call without proof must not be served");
  assert.equal(out.x402Version, 2);
  assert.ok(Array.isArray(out.accepts) && out.accepts.length > 0);
});

// FAILED_FINAL is terminal by design, and must stay terminal for anything
// with money in the story. For a free call it turned one upstream hiccup into
// a permanent refusal of that exact input — and answered 402 to do it, on an
// endpoint that costs nothing. Observed live: call one reported the upstream
// error, calls two onward were refused forever.
test("a free call that fails upstream can be retried, and is not answered 402", async () => {
  const g = guard();
  const failing = (async () => { throw new Error("store unreachable"); }) as unknown as typeof fetch;
  const attempt = async () => {
    globalThis.fetch = failing;
    try {
      return await handleMcpCall(g, { tool: TOOL_NAME, input: { action: "get_feed" }, identity: "agent-r" },
        0, PRODUCT_ID, stubStore());
    } finally { globalThis.fetch = realFetch; }
  };

  const first = await attempt();
  assert.match(String(first.error), /upstream call failed/);
  assert.equal(first.stage, "upstream", "the first failure names the upstream");

  // One retry, not three: the circuit breaker opens at three consecutive
  // upstream failures, and that protection is correct — the bug being pinned
  // here is a refusal that came from the operation record, not from it.
  const second = await attempt();
  assert.equal(second.stage, "upstream", "a retry must reach the upstream again, not be refused");
  assert.notEqual(second.stage, "payment", "and must never be answered as a payment condition");

  // And once the upstream recovers, the same input succeeds.
  await withCatalogue(async () => {
    const ok = await handleMcpCall(g, { tool: TOOL_NAME, input: { action: "get_feed" }, identity: "agent-r" },
      0, PRODUCT_ID, stubStore());
    assert.equal(ok.error, undefined, "a recovered upstream must not stay poisoned");
  });
});

// The other half of the same rule: money makes a failure final. A paid attempt
// that has already failed must not quietly run again — however it is refused,
// the upstream must not be reached a second time.
test("a paid operation that failed is not re-run", async () => {
  const g = guard();
  let upstreamCalls = 0;
  const ctxFor = () => ({
    productId: PRODUCT_ID, identityKind: "api_key" as const, identityValue: "buyer",
    authenticated: true, requestPayload: { action: "get_feed" },
    pricePerCall: 0.05, estimatedCost: 0.001, paymentReference: "ref-paid",
    upstreamName: PRODUCT_ID,
    upstream: async () => { upstreamCalls++; throw new Error("boom"); },
    actualCost: () => 0.001, requestId: "fixed-idempotency-key-000001",
  });

  const first = await g.processRequest(ctxFor());
  assert.equal(first.allowed, false);
  const after = upstreamCalls;

  const second = await g.processRequest(ctxFor());
  assert.equal(second.allowed, false, "a paid failure must not become a success on retry");
  assert.equal(upstreamCalls, after,
    "and must not reach the upstream again — that is how a buyer gets charged twice");
});
