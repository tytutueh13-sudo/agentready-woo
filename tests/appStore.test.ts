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

test("plan limits: free is 25 offers / 1 store, paid plans unlimited offers", () => {
  assert.equal(offerLimitFor("free"), 25);
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

test("public MCP usage stores only KST daily aggregates", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const justBeforeKstMidnight = Date.parse("2026-09-05T14:59:59.000Z");
  const justAfterKstMidnight = Date.parse("2026-09-05T15:00:01.000Z");
  await app.recordPublicMcpCall("scan_woo_store_readiness", "success", justBeforeKstMidnight);
  await app.recordPublicMcpCall("scan_woo_store_readiness", "success", justBeforeKstMidnight);
  await app.recordPublicMcpCall("scan_woo_store_readiness", "refused", justAfterKstMidnight);

  const rows = await db.prepare(
    "SELECT kst_date,tool_name,outcome,calls FROM agentready_public_mcp_usage_daily ORDER BY kst_date,outcome",
  ).all<{ kst_date: string; tool_name: string; outcome: string; calls: number }>();
  assert.deepEqual(rows.results.map(row => ({ ...row })), [
    { kst_date: "2026-09-05", tool_name: "scan_woo_store_readiness", outcome: "success", calls: 2 },
    { kst_date: "2026-09-06", tool_name: "scan_woo_store_readiness", outcome: "refused", calls: 1 },
  ]);
  assert.deepEqual(Object.keys(rows.results[0]).sort(), ["calls", "kst_date", "outcome", "tool_name"]);
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

test("AI allowance is aggregate-only, atomic, and refuses a request past its daily cap", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  assert.equal(await app.reserveAiBudget("2026-09-06", "fixture-model", 37, 74), true);
  assert.equal(await app.reserveAiBudget("2026-09-06", "fixture-model", 37, 74), true);
  assert.equal(await app.reserveAiBudget("2026-09-06", "fixture-model", 37, 74), false);
  await app.markAiOutcome("2026-09-06", "fixture-model", "success");
  await app.markAiOutcome("2026-09-06", "fixture-model", "unavailable");
  assert.deepEqual(await app.getAiUsage("2026-09-06", "fixture-model"), {
    reservedNeurons: 74, attempts: 2, successCount: 1, unavailableCount: 1,
  });
});

// --- Schema versioning ------------------------------------------------------
// On 2026-09-01 two tables were added to APP_TABLES without moving
// APP_SCHEMA_VERSION. Production still held the OLD checksum under the SAME
// version, so ensureSchema threw on every request that touched the database:
// the site rendered fine and every login and every scan answered 500. These
// tests describe the two halves of that guard.

test("a database migrated by an older build still starts", async () => {
  const { db } = sqliteD1();
  // Production as it was: an earlier version recorded, with whatever checksum
  // that build computed. The current version must not be blocked by it.
  await db.prepare("CREATE TABLE IF NOT EXISTS app_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)").run();
  await db.prepare("INSERT INTO app_schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)")
    .bind(3, "app_saas_baseline_v3", "a-checksum-from-an-older-build", Date.now()).run();

  const app = new AppStore(db);
  const user = await app.createUser("u-older", `older.build@${EMAIL_FIXTURE}`, "hash");
  assert.ok(user, "a store on a database migrated by an older build must work");

  // The old row is left exactly as it was — nothing rewrites another
  // version's history.
  const old = await db.prepare("SELECT name,checksum FROM app_schema_migrations WHERE version=3")
    .first<{ name: string; checksum: string }>();
  assert.equal(old?.checksum, "a-checksum-from-an-older-build");
});

test("the tables the new version added actually exist afterwards", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await app.createUser("u-tables", `tables@${EMAIL_FIXTURE}`, "hash");
  for (const table of ["unclaimed_purchases", "report_entitlements", "ai_usage_daily"]) {
    const row = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .bind(table).first<{ name: string }>();
    assert.ok(row, `${table} should have been created`);
  }
});

test("a corrupted record for the CURRENT version still refuses to start", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  // Migrate normally, then damage the recorded checksum for the version in
  // use. Refusing here is the point of the guard: silently running against a
  // schema that does not match would corrupt data rather than fail loudly.
  await app.createUser("u-guard", `guard@${EMAIL_FIXTURE}`, "hash");
  await db.prepare("UPDATE app_schema_migrations SET checksum='tampered' WHERE version=(SELECT MAX(version) FROM app_schema_migrations)").run();

  const fresh = new AppStore(db);
  await assert.rejects(() => fresh.createUser("u-guard2", `guard2@${EMAIL_FIXTURE}`, "hash"), /checksum mismatch/);
});
