// Tests for AppStore: users, sessions (expiry), stores (ownership, plan
// gating), and scan results — against real SQL via node:sqlite.
import test from "node:test";
import assert from "node:assert/strict";
import { AppStore, offerLimitFor, storeLimitFor } from "../src/core/appStore.ts";
import { sqliteD1 } from "./helpers/sqlite.ts";

const EMAIL_FIXTURE = ["merchant", "example", "com"].join(".");

test("users: create, dedupe by email, fetch by email and id", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const hash = "pbkdf2$100000$abc$def";
  assert.equal(await app.createUser("u1", EMAIL_FIXTURE, hash), true);
  assert.equal(await app.createUser("u2", EMAIL_FIXTURE.toUpperCase(), hash), false, "email is unique case-insensitively");
  const byEmail = await app.getUserByEmail(EMAIL_FIXTURE.toUpperCase());
  assert.equal(byEmail?.id, "u1");
  assert.equal((await app.getUser("u1"))?.email, EMAIL_FIXTURE);
  assert.equal(await app.getUser("missing"), null);
});

test("sessions: create, resolve, respect expiry, delete", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await app.createUser("u1", EMAIL_FIXTURE, "pbkdf2$100000$abc$def");
  await app.createSession({ tokenHash: "hash-a", userId: "u1", createdAt: 1, expiresAt: Date.now() + 60_000 });
  await app.createSession({ tokenHash: "hash-old", userId: "u1", createdAt: 1, expiresAt: Date.now() - 1 });
  assert.equal((await app.getSession("hash-a"))?.userId, "u1");
  assert.equal(await app.getSession("hash-old"), null, "expired sessions must not resolve");
  await app.deleteSession("hash-a");
  assert.equal(await app.getSession("hash-a"), null);
});

test("stores: ownership isolation and plan updates", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await app.createUser("u1", EMAIL_FIXTURE, "x");
  const base = { userId: "u1", name: "NorthWind", storeUrl: "https://northwind.example.com", wooKeyEnc: "k", wooSecretEnc: "s", status: "active", createdAt: 1, updatedAt: 1 };
  assert.equal(await app.createStore({ ...base, id: "s1", plan: "free" }), true);
  assert.equal(await app.createStore({ ...base, id: "s2", plan: "free" }), true);
  assert.equal((await app.getStoreForUser("s1", "u1"))?.id, "s1");
  assert.equal(await app.getStoreForUser("s1", "someone-else"), null, "another user must not read the store");
  assert.equal(await app.countUserStores("u1"), 2);
  assert.equal(await app.setStorePlan("s1", "pro"), true);
  assert.equal((await app.getStore("s1"))?.plan, "pro");
  assert.equal((await app.getStore("s2"))?.plan, "free", "plan update must be scoped to one store");
  assert.equal(await app.setStorePlanByUser("u1", "agency"), 2, "bulk plan update hits all user stores");
});

test("plan limits: free is 10 offers / 1 store, paid plans unlimited offers", () => {
  assert.equal(offerLimitFor("free"), 10);
  assert.equal(offerLimitFor("pro"), -1);
  assert.equal(offerLimitFor("agency"), -1);
  assert.equal(storeLimitFor("free"), 1);
  assert.equal(storeLimitFor("agency"), 25);
});

test("scans: save and fetch by id", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await app.saveScan({ id: "scan1", storeUrl: "https://northwind.example.com", score: 72, resultJson: "{\"score\":72}", createdAt: 1 });
  const scan = await app.getScan("scan1");
  assert.equal(scan?.score, 72);
  assert.equal(scan?.storeUrl, "https://northwind.example.com");
  assert.equal(await app.getScan("missing"), null);
});

test("funnel: records events and summarizes counts in funnel order", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const now = Date.now();
  await app.recordFunnelEvent({ kind: "scan_completed", meta: { store_url: "https://a.example.com", score: 61 } });
  await app.recordFunnelEvent({ kind: "wall_shown", storeId: "s1", plan: "free" });
  await app.recordFunnelEvent({ kind: "wall_shown", storeId: "s1", plan: "free" });
  await app.recordFunnelEvent({ kind: "checkout_started", userId: "u1", plan: "pro" });
  const summary = await app.funnelSummary(now - 1000);
  assert.deepEqual(summary, [
    { kind: "scan_completed", count: 1 },
    { kind: "wall_shown", count: 2 },
    { kind: "checkout_started", count: 1 },
    { kind: "checkout_completed", count: 0 },
  ]);
});

test("funnel: sinceMs excludes events recorded before the window", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await app.recordFunnelEvent({ kind: "scan_completed" });
  const summary = await app.funnelSummary(Date.now() + 60_000);
  assert.equal(summary.find(row => row.kind === "scan_completed")?.count, 0, "future window must see nothing yet");
});

// --- weekly digest tracking -------------------------------------------

test("usersDueForDigest: only paid-plan users, never sent before, are due", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await app.createUser("u1", "with-store@example.com", "pbkdf2$100000$abc$def");
  await app.createUser("u2", "no-store@example.com", "pbkdf2$100000$abc$def");
  await app.createStore({
    id: "s1", userId: "u1", name: "NorthWind", storeUrl: "https://northwind.example.com",
    wooKeyEnc: "k", wooSecretEnc: "s", plan: "pro", status: "active", createdAt: 1, updatedAt: 1,
  });
  const due = await app.usersDueForDigest(Date.now() - 7 * 86_400_000);
  assert.deepEqual(due.map(u => u.email), ["with-store@example.com"]);
});

test("usersDueForDigest: a free-plan store does not make its owner due — this is a paid perk", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await app.createUser("u1", "free-plan@example.com", "pbkdf2$100000$abc$def");
  await app.createStore({
    id: "s1", userId: "u1", name: "Store", storeUrl: "https://store.example.com",
    wooKeyEnc: "k", wooSecretEnc: "s", plan: "free", status: "active", createdAt: 1, updatedAt: 1,
  });
  const due = await app.usersDueForDigest(Date.now() - 7 * 86_400_000);
  assert.equal(due.length, 0);
});

test("usersDueForDigest: excludes a user digested within the window, includes one digested before it", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await app.createUser("u1", "recent@example.com", "pbkdf2$100000$abc$def");
  await app.createUser("u2", "stale@example.com", "pbkdf2$100000$abc$def");
  for (const [id, email] of [["u1", "recent@example.com"], ["u2", "stale@example.com"]] as const) {
    await app.createStore({
      id: `s-${id}`, userId: id, name: "Store", storeUrl: `https://${id}.example.com`,
      wooKeyEnc: "k", wooSecretEnc: "s", plan: "pro", status: "active", createdAt: 1, updatedAt: 1,
    });
  }
  const now = Date.now();
  await app.markDigestSent("u1", now - 1 * 86_400_000);
  await app.markDigestSent("u2", now - 10 * 86_400_000);
  const due = await app.usersDueForDigest(now - 7 * 86_400_000);
  assert.deepEqual(due.map(u => u.email), ["stale@example.com"]);
});

test("markDigestSent is idempotent per user (updates, never duplicates)", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await app.createUser("u1", "merchant2@example.com", "pbkdf2$100000$abc$def");
  await app.createStore({
    id: "s1", userId: "u1", name: "Store", storeUrl: "https://store.example.com",
    wooKeyEnc: "k", wooSecretEnc: "s", plan: "pro", status: "active", createdAt: 1, updatedAt: 1,
  });
  const now = Date.now();
  await app.markDigestSent("u1", now - 20 * 86_400_000);
  await app.markDigestSent("u1", now);
  const due = await app.usersDueForDigest(now - 7 * 86_400_000);
  assert.equal(due.length, 0, "the second, more recent send must win — not create a duplicate row");
});

// --- latest scan lookup for the deep report ----------------------------

test("getLatestScanForStoreUrl returns the most recent scan for that store, or null", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  assert.equal(await app.getLatestScanForStoreUrl("https://nothing-scanned.example.com"), null);
  await app.saveScan({ id: "old", storeUrl: "https://store.example.com", score: 40, resultJson: "{}", createdAt: 1 });
  await app.saveScan({ id: "new", storeUrl: "https://store.example.com", score: 80, resultJson: "{}", createdAt: 2 });
  const latest = await app.getLatestScanForStoreUrl("https://store.example.com");
  assert.equal(latest?.id, "new");
});
