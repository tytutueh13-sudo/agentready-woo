// The route half of the Apify seam: who counts as the channel, what the
// channel is allowed to skip, and what it is never allowed to skip.
//
// The bypass shapes that must not work are tested by trying them.
import test from "node:test";
import assert from "node:assert/strict";
import { handleAppRequest, type AppEnv } from "../src/app.ts";
import { AppStore } from "../src/core/appStore.ts";
import { RevenueGuard } from "../src/core/guard.ts";
import { MemoryStore } from "../src/core/memoryStore.ts";
import { MockPaymentProvider } from "../src/core/paymentProvider.ts";
import { sqliteD1 } from "./helpers/sqlite.ts";

const CHANNEL = "apify-batch-preflight";
const SECRET = "channel-secret-for-tests-only-not-a-real-credential";
const ORIGIN = "https://shop.example.com";

function guard(): RevenueGuard {
  return new RevenueGuard(new MemoryStore(), {
    productId: "test", pricePerCall: 0.05, freeCallsPerDay: 0, dailyBudgetUsd: 1,
  } as never, new MockPaymentProvider(), {});
}

function harness(overrides: Partial<AppEnv> = {}) {
  const { db, raw } = sqliteD1();
  const env: AppEnv = {
    FINANCIAL_DB: db, APP_ENCRYPTION_SECRET: "a".repeat(48),
    CART_SIGNING_SECRET: "cart", PUBLIC_BASE_URL: "https://worker.example.com",
    ...overrides,
  } as AppEnv;
  return { env, db, raw, app: new AppStore(db as never) };
}

async function preflight(env: AppEnv, headers: Record<string, string> = {},
                         body: Record<string, unknown> = { store_origin: ORIGIN }) {
  const url = new URL("https://worker.example.com/api/v2/preflight");
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers },
    body: JSON.stringify(body),
  });
  const response = await handleAppRequest(request, env, url, guard());
  assert.ok(response, "the route must handle /api/v2/preflight");
  return response;
}

// -- who is the channel -----------------------------------------------------

test("with no configured secret there is no channel, and the public limits apply", async () => {
  const { env, app } = harness();                       // PREFLIGHT_CHANNEL_TOKEN unset
  await app.setChannelDailyCap(CHANNEL, 100);
  // eleven calls from one address: the eleventh must be refused, bearer or not
  const codes: number[] = [];
  for (let i = 0; i < 11; i += 1) {
    const r = await preflight(env, { authorization: `Bearer ${SECRET}` },
                              { store_origin: `https://shop-${i}.example.com` });
    codes.push(r.status);
  }
  assert.equal(codes.filter(c => c === 429).length >= 1, true,
    "an unset secret must not open an unlimited path");
});

test("a wrong bearer token is an ordinary public caller", async () => {
  const { env, app } = harness({ PREFLIGHT_CHANNEL_TOKEN: SECRET });
  await app.setChannelDailyCap(CHANNEL, 100);
  const codes: number[] = [];
  for (let i = 0; i < 11; i += 1) {
    const r = await preflight(env, { authorization: "Bearer not-the-secret" },
                              { store_origin: `https://shop-${i}.example.com` });
    codes.push(r.status);
  }
  assert.equal(codes.includes(429), true, "a wrong token must fall back to the IP limit");
  assert.equal(await app.channelBudgetUsed(new Date().toISOString().slice(0, 10), CHANNEL), 0,
    "a wrong token must not spend channel budget");
});

test("no User-Agent, IP or query string can stand in for the token", async () => {
  const { env, app } = harness({ PREFLIGHT_CHANNEL_TOKEN: SECRET });
  await app.setChannelDailyCap(CHANNEL, 100);
  const day = new Date().toISOString().slice(0, 10);

  const attempts: Array<Record<string, string>> = [
    { "user-agent": "Apify/1.0 (+https://apify.com)" },
    { "cf-connecting-ip": "34.201.0.1" },
    { "x-forwarded-for": "34.201.0.1" },
    { authorization: `Basic ${SECRET}` },
    { authorization: SECRET },
  ];
  for (const headers of attempts) {
    await preflight(env, headers, { store_origin: `https://ua-${Math.random()}.example.com` });
  }
  assert.equal(await app.channelBudgetUsed(day, CHANNEL), 0,
    "only a correct Bearer token identifies the channel");
});

// -- what the channel may skip, and what it may not -------------------------

test("the channel skips the shared-IP limit and spends its own budget instead", async () => {
  const { env, app } = harness({ PREFLIGHT_CHANNEL_TOKEN: SECRET });
  await app.setChannelDailyCap(CHANNEL, 25);
  const day = new Date().toISOString().slice(0, 10);

  const codes: number[] = [];
  for (let i = 0; i < 15; i += 1) {                    // more than the public 10/day
    const r = await preflight(env, { authorization: `Bearer ${SECRET}` },
                              { store_origin: `https://shop-${i}.example.com` });
    codes.push(r.status);
  }
  assert.equal(codes.filter(c => c === 429).length, 0,
    "fifteen distinct origins is exactly the case the IP counter broke");
  assert.equal(await app.channelBudgetUsed(day, CHANNEL), 15);
});

test("an unconfigured channel budget refuses even a correct token", async () => {
  const { env } = harness({ PREFLIGHT_CHANNEL_TOKEN: SECRET });   // no cap set
  const r = await preflight(env, { authorization: `Bearer ${SECRET}` });
  assert.equal(r.status, 429);
  assert.equal((await r.json() as { code: string }).code, "TARGET_RATE_LIMITED");
  assert.ok(r.headers.get("retry-after"), "a daily limit should say when to come back");
});

test("the per-target-origin limit survives the channel", async () => {
  // It protects a merchant's store, not our capacity, so authentication does
  // not buy more of it.
  const { env, app } = harness({ PREFLIGHT_CHANNEL_TOKEN: SECRET });
  await app.setChannelDailyCap(CHANNEL, 100);

  const codes: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await preflight(env, { authorization: `Bearer ${SECRET}` },
                              { store_origin: ORIGIN });          // the SAME origin
    codes.push(r.status);
  }
  assert.equal(codes.filter(c => c === 429).length, 2,
    "three per target origin per day, for the channel too");
});

// -- idempotency at the route ----------------------------------------------

test("a replayed run and item returns the first outcome without spending budget", async () => {
  const { env, app } = harness({ PREFLIGHT_CHANNEL_TOKEN: SECRET });
  await app.setChannelDailyCap(CHANNEL, 50);
  const day = new Date().toISOString().slice(0, 10);
  const keys = { authorization: `Bearer ${SECRET}`,
                 "x-agentready-run": "run-abc123", "x-agentready-item": "item-000001" };

  const first = await preflight(env, keys);
  const spentAfterFirst = await app.channelBudgetUsed(day, CHANNEL);
  assert.equal(spentAfterFirst, 1);

  const replay = await preflight(env, keys);
  const body = await replay.json() as { code?: string; billable?: boolean };
  assert.equal(body.code, "REPLAYED");
  assert.equal(await app.channelBudgetUsed(day, CHANNEL), spentAfterFirst,
    "a replay must not consume a second unit, or a retried run bills twice");
  void first;
});

test("idempotency headers are ignored for a public caller", async () => {
  const { env, app } = harness({ PREFLIGHT_CHANNEL_TOKEN: SECRET });
  await app.setChannelDailyCap(CHANNEL, 50);
  await preflight(env, { "x-agentready-run": "run-abc123", "x-agentready-item": "item-1" });
  const replay = await preflight(env, { "x-agentready-run": "run-abc123", "x-agentready-item": "item-1" });
  assert.notEqual((await replay.json() as { code?: string }).code, "REPLAYED",
    "the public contract has no idempotency keys and must not gain one");
});

test("a malformed idempotency key is ignored rather than trusted", async () => {
  const { env, app } = harness({ PREFLIGHT_CHANNEL_TOKEN: SECRET });
  await app.setChannelDailyCap(CHANNEL, 50);
  const day = new Date().toISOString().slice(0, 10);
  const headers = { authorization: `Bearer ${SECRET}`,
                    "x-agentready-run": "a b/c", "x-agentready-item": "x" };
  await preflight(env, headers, { store_origin: "https://shop-a.example.com" });
  await preflight(env, headers, { store_origin: "https://shop-b.example.com" });
  assert.equal(await app.channelBudgetUsed(day, CHANNEL), 2,
    "an unusable key means no idempotency, not free calls");
});

// -- the contract the body keeps -------------------------------------------

test("the channel does not widen the request contract", async () => {
  const { env, app } = harness({ PREFLIGHT_CHANNEL_TOKEN: SECRET });
  await app.setChannelDailyCap(CHANNEL, 50);
  const r = await preflight(env, { authorization: `Bearer ${SECRET}` },
                            { store_origin: ORIGIN, depth: 3 });
  assert.equal(r.status, 400);
  assert.equal((await r.json() as { code: string }).code, "UNKNOWN_PROPERTY",
    "an authenticated caller gets the same strict body check as anyone else");
});

test("the channel cannot reach an owner-authorized operation", async () => {
  const { env } = harness({ PREFLIGHT_CHANNEL_TOKEN: SECRET });
  const url = new URL("https://worker.example.com/api/v2/acceptance-runs");
  const response = await handleAppRequest(new Request(url, {
    method: "POST", headers: { "content-type": "application/json",
                               authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ store_id: "store-1234", mode: "owned-safe-active",
                           requested_families: ["woo"], idempotency_key: "k".repeat(20) }),
  }), env, url, guard());
  assert.ok(response);
  assert.notEqual(response.status, 200,
    "the preflight channel credential is not an ownership credential");
});
