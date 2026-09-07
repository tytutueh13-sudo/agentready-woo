// A scan that reached a store and could not read it used to be counted as a
// completed scan, because `funnel_events.kind` has a CHECK constraint listing
// four values and the abstention had nowhere else to go. Every conversion rate
// computed from that number was inflated by traffic that never got an answer.
//
// The outcome is now derived from meta_json in SQL. These pin the derivation,
// the conservation law, and the fact that no raw row escapes.
import test from "node:test";
import assert from "node:assert/strict";
import { AppStore } from "../src/core/appStore.ts";
import { handleAppRequest } from "../src/app.ts";
import { RevenueGuard } from "../src/core/guard.ts";
import { MemoryStore } from "../src/core/memoryStore.ts";
import { MockPaymentProvider } from "../src/core/paymentProvider.ts";
import { sqliteD1 } from "./helpers/sqlite.ts";

function guard(): RevenueGuard {
  return new RevenueGuard(new MemoryStore(), {
    productId: "test", pricePerCall: 0.05, freeCallsPerDay: 0, dailyBudgetUsd: 1,
  } as never, new MockPaymentProvider(), {});
}

/** One row of each kind the table can hold, present and historical. */
async function seed(app: AppStore): Promise<void> {
  // current writer, answered
  await app.recordFunnelEvent({ kind: "scan_completed", meta: { store_url: "https://a.example.com", score: 61, state: "SCORED", via: "form" } });
  // current writer, abstained
  await app.recordFunnelEvent({ kind: "scan_completed", meta: { store_url: "https://b.example.com", score: -1, state: "UNREADABLE", via: "form" } });
  // legacy: scored before `state` existed
  await app.recordFunnelEvent({ kind: "scan_completed", meta: { store_url: "https://c.example.com", score: 44 } });
  // legacy: neither state nor score
  await app.recordFunnelEvent({ kind: "scan_completed", meta: { store_url: "https://d.example.com" } });
}

test("the four row shapes are classified as attempted, answered, abstained and unknown", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const since = Date.now() - 1000;
  await seed(app);
  assert.deepEqual(await app.scanOutcomeSummary(since),
    { attempted: 4, answered: 2, abstained: 1, unknown: 1 });
});

test("attempted always equals answered plus abstained plus unknown", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const since = Date.now() - 1000;
  await seed(app);
  for (let i = 0; i < 7; i += 1) {
    await app.recordFunnelEvent({ kind: "scan_completed", meta: { score: i % 2 ? -1 : i, state: i % 2 ? "UNREADABLE" : "SCORED" } });
  }
  const s = await app.scanOutcomeSummary(since);
  assert.equal(s.attempted, s.answered + s.abstained + s.unknown,
    "the conservation law is what makes these numbers safe to quote");
  assert.equal(s.attempted, 11);
});

test("an abstention does not increase the answered count", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const since = Date.now() - 1000;
  await app.recordFunnelEvent({ kind: "scan_completed", meta: { score: -1, state: "UNREADABLE" } });
  assert.deepEqual(await app.scanOutcomeSummary(since),
    { attempted: 1, answered: 0, abstained: 1, unknown: 0 });
  assert.equal((await app.funnelSummary(since)).find(r => r.kind === "scan_completed")?.count, 0);
});

test("an abstention is counted exactly once, in attempted and in abstained", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const since = Date.now() - 1000;
  await app.recordFunnelEvent({ kind: "scan_completed", meta: { score: -1, state: "UNREADABLE" } });
  const s = await app.scanOutcomeSummary(since);
  assert.equal(s.attempted, 1);
  assert.equal(s.abstained, 1);
});

test("the negative-score sentinel is read as an abstention even without a state", async () => {
  // Rows written between the abstention fix and the state field landing.
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const since = Date.now() - 1000;
  await app.recordFunnelEvent({ kind: "scan_completed", meta: { store_url: "https://x.example.com", score: -1 } });
  assert.deepEqual(await app.scanOutcomeSummary(since),
    { attempted: 1, answered: 0, abstained: 1, unknown: 0 });
});

test("a zero score is an answer, not a sentinel", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const since = Date.now() - 1000;
  await app.recordFunnelEvent({ kind: "scan_completed", meta: { score: 0, state: "SCORED" } });
  assert.equal((await app.scanOutcomeSummary(since)).answered, 1);
});

test("an unclassifiable legacy row is never counted as a success", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const since = Date.now() - 1000;
  await app.recordFunnelEvent({ kind: "scan_completed", meta: { store_url: "https://d.example.com" } });
  const s = await app.scanOutcomeSummary(since);
  assert.equal(s.unknown, 1);
  assert.equal(s.answered, 0);
  assert.equal((await app.funnelSummary(since)).find(r => r.kind === "scan_completed")?.count, 0);
});

test("the API path and the form path are classified by the same rule", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const since = Date.now() - 1000;
  for (const via of ["api", "form"]) {
    await app.recordFunnelEvent({ kind: "scan_completed", meta: { score: -1, state: "UNREADABLE", via } });
    await app.recordFunnelEvent({ kind: "scan_completed", meta: { score: 70, state: "SCORED", via } });
  }
  assert.deepEqual(await app.scanOutcomeSummary(since),
    { attempted: 4, answered: 2, abstained: 2, unknown: 0 });
});

test("the window boundary excludes older rows and repeated reads do not double count", async () => {
  const { db, raw } = sqliteD1();
  const app = new AppStore(db);
  await app.recordFunnelEvent({ kind: "scan_completed", meta: { score: 61, state: "SCORED" } });
  // Age that row past the window rather than sleeping.
  raw.prepare("UPDATE funnel_events SET created_at = ?").run(Date.now() - 10 * 86_400_000);
  await app.recordFunnelEvent({ kind: "scan_completed", meta: { score: -1, state: "UNREADABLE" } });
  const since = Date.now() - 86_400_000;
  const first = await app.scanOutcomeSummary(since);
  const second = await app.scanOutcomeSummary(since);
  assert.deepEqual(first, { attempted: 1, answered: 0, abstained: 1, unknown: 0 });
  assert.deepEqual(second, first, "a read must not change what it counts");
});

test("the other funnel stages are untouched by the outcome split", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const since = Date.now() - 1000;
  await seed(app);
  await app.recordFunnelEvent({ kind: "wall_shown", storeId: "s1", plan: "free" });
  await app.recordFunnelEvent({ kind: "wall_shown", storeId: "s1", plan: "free" });
  await app.recordFunnelEvent({ kind: "checkout_started", userId: "u1", plan: "pro" });
  await app.recordFunnelEvent({ kind: "checkout_completed", userId: "u1", plan: "pro" });
  assert.deepEqual(await app.funnelSummary(since), [
    { kind: "scan_completed", count: 2 },
    { kind: "wall_shown", count: 2 },
    { kind: "checkout_started", count: 1 },
    { kind: "checkout_completed", count: 1 },
  ]);
});

// -- the operations endpoint ------------------------------------------------

async function opsBody(db: unknown, token: string): Promise<Record<string, unknown>> {
  const url = new URL("https://worker.example.com/ops/funnel");
  const request = new Request(url, { headers: { authorization: `Bearer ${token}` } });
  const env = { FINANCIAL_DB: db, OPS_TOKEN: token, APP_ENCRYPTION_SECRET: "a".repeat(48),
                CART_SIGNING_SECRET: "c", PUBLIC_BASE_URL: "https://worker.example.com" };
  const response = await handleAppRequest(request, env as never, url, guard());
  assert.ok(response);
  assert.equal(response.status, 200);
  return await response.json() as Record<string, unknown>;
}

test("the operations endpoint reports both the funnel and the outcome split", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await seed(app);
  const body = await opsBody(db, "t".repeat(40));
  assert.deepEqual(body.scan_outcomes, { attempted: 4, answered: 2, abstained: 1, unknown: 1 });
  const funnel = body.funnel as { kind: string; count: number }[];
  assert.equal(funnel.find(r => r.kind === "scan_completed")?.count, 2);
});

test("the operations response carries counts only, never a stored URL or raw meta", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await seed(app);
  await app.recordFunnelEvent({ kind: "scan_completed", meta: { store_url: "https://secret-merchant.example.com", score: 1, state: "SCORED" } });
  const raw = JSON.stringify(await opsBody(db, "t".repeat(40)));
  for (const forbidden of ["secret-merchant", "https://", "store_url", "meta_json", "@", "via"]) {
    assert.equal(raw.includes(forbidden), false, `${forbidden} reached an operations response`);
  }
});

test("the endpoint explains what scan_completed now means", async () => {
  // The number changed meaning; a reader of the old dashboard has to be told.
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await seed(app);
  const notes = (await opsBody(db, "t".repeat(40))).notes as Record<string, string>;
  assert.match(notes.scan_completed, /answered/i);
  assert.match(notes.attempted, /answered \+ abstained \+ unknown/);
});
