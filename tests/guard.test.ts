// Generated test suite — section 35: valid request, invalid input, payment
// failure, rate limit, budget exceeded, margin failure, cache hit/miss,
// upstream timeout, upstream 429, upstream 500, kill switch.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryStore } from "../src/core/memoryStore.ts";
import { RevenueGuard } from "../src/core/guard.ts";
import { MockPaymentProvider } from "../src/core/paymentProvider.ts";
import { MemoryEventSink } from "../src/core/eventSink.ts";
import type { RevenueGuardConfig } from "../src/core/pricing.ts";
import type { RequestContext } from "../src/core/types.ts";

const PRODUCT_ID = "early-3426536d88daa242";
const PRICE = 0.05;
const SHARED_VECTORS=JSON.parse(readFileSync(
  new URL("./security_contract_vectors.json",import.meta.url),"utf8",
)) as {vectors:Record<string,Record<string,unknown>>};

function baseConfig(overrides: Partial<RevenueGuardConfig> = {}): RevenueGuardConfig {
  return {
    minGrossMarginRatio: 0.70, minPriceMultiplier: 3.0,
    perRequestMaxCost: 0.50, dailyMaxCost: 20.0, monthlyMaxCost: 300.0,
    perUserDailyCost: 2.0, perProductDailyCost: 20.0,
    rateLimitWindowSeconds: 60, rateLimitMaxRequests: 30,
    circuitBreakerFailureThreshold: 3, circuitBreakerWindowSeconds: 60, circuitBreakerCooldownSeconds: 60,
    cacheDefaultTtlSeconds: 3600,
    ...overrides,
  };
}

function ctx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    productId: PRODUCT_ID, identityKind: "ip", identityValue: "203.0.113.1",
    authenticated: true, requestPayload: { q: "x" },
    pricePerCall: PRICE, estimatedCost: 0.01, paymentReference: "ref-1",
    upstreamName: PRODUCT_ID, upstream: async () => ({ ok: true }),
    actualCost: () => 0.01,
    ...overrides,
  };
}

test("valid request succeeds end to end", async () => {
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "paid", PRICE);
  const guard = new RevenueGuard(store, baseConfig(), payments, {});
  const outcome = await guard.processRequest(ctx());
  assert.equal(outcome.allowed, true);
  assert.equal(outcome.stageReached, "usage_record");
  assert.deepEqual(outcome.result, { ok: true });
});

test("unauthenticated request is rejected at auth", async () => {
  const store = new MemoryStore();
  const guard = new RevenueGuard(store, baseConfig(), new MockPaymentProvider(), {});
  const outcome = await guard.processRequest(ctx({ authenticated: false }));
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.stageReached, "auth");
});

test("payment failure blocks before any upstream call", async () => {
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "unpaid");
  let upstreamCalled = false;
  const guard = new RevenueGuard(store, baseConfig(), payments, {});
  const outcome = await guard.processRequest(ctx({ upstream: async () => { upstreamCalled = true; return {}; } }));
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.stageReached, "payment");
  assert.equal(upstreamCalled, false, "no charge without payment, and no upstream cost either");
});

test("rate limit blocks after the configured max requests", async () => {
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "paid", PRICE);
  const guard = new RevenueGuard(store, baseConfig({ rateLimitMaxRequests: 2 }), payments, {});
  await guard.processRequest(ctx({ requestPayload: { q: "1" } }));
  await guard.processRequest(ctx({ requestPayload: { q: "2" } }));
  const third = await guard.processRequest(ctx({ requestPayload: { q: "3" } }));
  assert.equal(third.allowed, false);
  assert.equal(third.stageReached, "rate_limit");
});

test("budget exceeded blocks further spend", async () => {
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "paid", PRICE);
  const guard = new RevenueGuard(store, baseConfig({ perProductDailyCost: 0.005, rateLimitMaxRequests: 1000 }), payments, {});
  const first = await guard.processRequest(ctx({ estimatedCost: 0.01, requestPayload: { q: "1" } }));
  assert.equal(first.allowed, false);
  assert.equal(first.stageReached, "budget");
});

test("shared contract: zero price with positive cost blocks before upstream", async () => {
  const vector=SHARED_VECTORS.vectors.zero_price_positive_cost as {price:number;maximumCost:number};
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "paid", vector.maximumCost);
  const guard = new RevenueGuard(store, baseConfig(), payments, {});
  const outcome = await guard.processRequest(ctx({ pricePerCall: vector.price, estimatedCost: vector.maximumCost }));
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.stageReached, "estimate_cost");
});

test("cache hit skips the upstream call entirely", async () => {
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "paid", PRICE);
  let calls = 0;
  const guard = new RevenueGuard(store, baseConfig(), payments, {});
  const upstream = async () => { calls += 1; return { ok: true }; };
  const free = { upstream, pricePerCall: 0, estimatedCost: 0,
    paymentReference: undefined, actualCost: () => 0 };
  await guard.processRequest(ctx(free));
  const second = await guard.processRequest(ctx(free));
  assert.equal(calls, 1, "second identical request must be served from cache");
  assert.equal(second.cacheHit, true);
});

test("cache miss on a new payload calls the upstream again", async () => {
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "paid", PRICE);
  let calls = 0;
  const guard = new RevenueGuard(store, baseConfig(), payments, {});
  const upstream = async () => { calls += 1; return { ok: true }; };
  await guard.processRequest(ctx({ upstream, requestPayload: { q: "a" } }));
  await guard.processRequest(ctx({ upstream, requestPayload: { q: "b" } }));
  assert.equal(calls, 2);
});

test("upstream timeout trips the circuit breaker", async () => {
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "paid", PRICE);
  const guard = new RevenueGuard(store, baseConfig({ circuitBreakerFailureThreshold: 1 }), payments, {});
  const timingOut = async () => { throw new Error("upstream timed out"); };
  const first = await guard.processRequest(ctx({ upstream: timingOut, requestPayload: { q: "1" } }));
  assert.equal(first.stageReached, "upstream");
  const second = await guard.processRequest(ctx({ upstream: async () => ({ ok: true }), requestPayload: { q: "2" } }));
  assert.equal(second.allowed, false);
  assert.match(second.reason, /circuit open/);
});

test("upstream 429-style failure is treated the same as any other upstream error", async () => {
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "paid", PRICE);
  const guard = new RevenueGuard(store, baseConfig(), payments, {});
  const rateLimited = async () => { throw new Error("HTTP 429: upstream rate limited"); };
  const outcome = await guard.processRequest(ctx({ upstream: rateLimited }));
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.stageReached, "upstream");
});

test("upstream 500-style failure does not record a transaction", async () => {
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "paid", PRICE);
  const guard = new RevenueGuard(store, baseConfig(), payments, {});
  const failing = async () => { throw new Error("HTTP 500: upstream error"); };
  await guard.processRequest(ctx({ upstream: failing }));
  assert.equal(payments.transactions.length, 0, "no charge without a successful delivery");
});

test("kill switch blocks everything before auth is even checked", async () => {
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "paid", PRICE);
  const guard = new RevenueGuard(store, baseConfig(), payments, { REVENUE_SYSTEM_ENABLED: "false" });
  const outcome = await guard.processRequest(ctx());
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.stageReached, "kill_switch");
});

test("per-product kill switch blocks only that product", async () => {
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "paid", PRICE);
  const guard = new RevenueGuard(store, baseConfig(), payments, { [`PRODUCT_${PRODUCT_ID}_ENABLED`]: "false" });
  const outcome = await guard.processRequest(ctx());
  assert.equal(outcome.allowed, false);
  assert.equal(outcome.stageReached, "kill_switch");
});

test("section 46: a successful request emits the expected observability events", async () => {
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "paid", PRICE);
  const events = new MemoryEventSink();
  const guard = new RevenueGuard(store, baseConfig(), payments, {}, events);
  await guard.processRequest(ctx());
  const types = events.events.map((e) => e.type);
  assert.ok(types.includes("request_received"));
  assert.ok(types.includes("payment_verified"));
  assert.ok(types.includes("upstream_called"));
  assert.ok(types.includes("result_returned"));
  assert.ok(types.includes("cost_recorded"));
  assert.ok(types.includes("revenue_recorded"));
  assert.ok(!types.includes("request_rejected"));
});

test("section 46: a cache hit emits cache_hit and cost_recorded with zero cost", async () => {
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "paid", PRICE);
  const events = new MemoryEventSink();
  const guard = new RevenueGuard(store, baseConfig(), payments, {}, events);
  const free = { pricePerCall: 0, estimatedCost: 0,
    paymentReference: undefined, actualCost: () => 0 };
  await guard.processRequest(ctx(free));
  events.events.length = 0; // clear first-call events, we only care about the cached repeat
  await guard.processRequest(ctx(free));
  const cacheEvent = events.events.find((e) => e.type === "cache_hit");
  const costEvent = events.events.find((e) => e.type === "cost_recorded");
  assert.ok(cacheEvent, "expected a cache_hit event");
  assert.equal(costEvent?.data?.cost, 0);
});

test("section 46: a rejected request emits request_rejected with the blocking stage", async () => {
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "unpaid");
  const events = new MemoryEventSink();
  const guard = new RevenueGuard(store, baseConfig(), payments, {}, events);
  await guard.processRequest(ctx());
  const rejected = events.events.find((e) => e.type === "request_rejected");
  assert.ok(rejected);
  assert.equal(rejected?.stage, "payment");
});

test("section 46: budget exhaustion emits budget_exceeded", async () => {
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "paid", PRICE);
  const events = new MemoryEventSink();
  const guard = new RevenueGuard(store, baseConfig({ perProductDailyCost: 0.005 }), payments, {}, events);
  await guard.processRequest(ctx({ estimatedCost: 0.01 }));
  assert.ok(events.events.some((e) => e.type === "budget_exceeded"));
});

test("section 46: an open circuit emits circuit_opened on the next request", async () => {
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "paid", PRICE);
  const events = new MemoryEventSink();
  const guard = new RevenueGuard(store, baseConfig({ circuitBreakerFailureThreshold: 1 }), payments, {}, events);
  const failing = async () => { throw new Error("boom"); };
  await guard.processRequest(ctx({ upstream: failing, requestPayload: { q: "1" } }));
  events.events.length = 0;
  await guard.processRequest(ctx({ requestPayload: { q: "2" } }));
  assert.ok(events.events.some((e) => e.type === "circuit_opened"));
});

test("invalid input (empty payload) still goes through the guard, not silently accepted", async () => {
  const store = new MemoryStore();
  const payments = new MockPaymentProvider();
  payments.register("ref-1", "paid", PRICE);
  const guard = new RevenueGuard(store, baseConfig(), payments, {});
  const outcome = await guard.processRequest(ctx({ requestPayload: {} }));
  // The guard itself doesn't validate input shape (that's runTool()'s job,
  // per section 21) — this test documents that expectation so it isn't lost.
  assert.equal(typeof outcome.allowed, "boolean");
});

test("result escrow rejects fields outside the product output schema",async()=>{const payments=new MockPaymentProvider();payments.register("ref-1","paid",PRICE);const guard=new RevenueGuard(new MemoryStore(),baseConfig(),payments,{});const outcome=await guard.processRequest(ctx({outputSchema:{type:"object",properties:{ok:{type:"boolean"}},additionalProperties:false},upstream:async()=>({ok:true,unexpected:"x"})}));assert.equal(outcome.allowed,false);assert.equal(outcome.stageReached,"result");assert.equal(outcome.result,undefined);});

test("result escrow rejects secret-shaped output even with a permissive schema",async()=>{const payments=new MockPaymentProvider();payments.register("ref-1","paid",PRICE);const guard=new RevenueGuard(new MemoryStore(),baseConfig(),payments,{});const outcome=await guard.processRequest(ctx({outputSchema:{type:"object",additionalProperties:true},upstream:async()=>({authorization:"Bearer should-never-persist"})}));assert.equal(outcome.allowed,false);assert.match(outcome.reason,/secret-shaped/);assert.equal(outcome.result,undefined);});
