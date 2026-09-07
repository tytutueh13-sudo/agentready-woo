// A paid Deep Report is a debt the product remembers until it is settled.
//
// Before this existed, buying the report fired one email. If the buyer had
// not scanned yet, that email said "reply and we'll send it" and the $9
// lived in an inbox — coming back the next day, the app showed no trace of
// the purchase at all. These tests pin the three properties that fix:
// the claim survives a failed delivery, a later scan settles it without
// anyone asking, and the delivered report stays readable in the app.
import test from "node:test";
import assert from "node:assert/strict";
import { AppStore, REPORT_CLAIM_TTL_MS } from "../src/core/appStore.ts";
import { sqliteD1 } from "./helpers/sqlite.ts";

async function seedUser(app: AppStore, id = "u1", email = "buyer@example.com") {
  await app.createUser(id, email, "x");
  return { id, email };
}

test("a purchase with nothing to report on leaves a claim, not silence", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const user = await seedUser(app);

  await app.createReportEntitlement(user.id);

  const owed = await app.oldestUnfulfilledReport(user.id);
  assert.ok(owed, "the purchase must survive as a claim");
  assert.equal(owed!.fulfilledAt, null);
  assert.equal(owed!.reportHtml, null);
});

test("the claim is visible to the buyer, with its expiry", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const user = await seedUser(app);
  await app.createReportEntitlement(user.id);

  const listed = await app.listReportEntitlements(user.id);
  assert.equal(listed.length, 1);
  // Generous on purpose: a short window would mean taking the money and
  // then refusing to deliver.
  const window = listed[0].expiresAt - listed[0].purchasedAt;
  assert.equal(window, REPORT_CLAIM_TTL_MS);
  assert.ok(window > 300 * 24 * 60 * 60 * 1000, "claim window must not be short");
});

test("settling stores the report so it can be re-read in the app", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const user = await seedUser(app);
  const id = await app.createReportEntitlement(user.id);

  const settled = await app.fulfilReportEntitlement(id, "scan-1", user.email, "<h1>Your report</h1>");
  assert.equal(settled, true);

  const owned = await app.getReportEntitlement(id, user.id);
  assert.ok(owned?.fulfilledAt, "delivery must be recorded");
  assert.equal(owned!.reportHtml, "<h1>Your report</h1>");
  assert.equal(owned!.scanId, "scan-1");
  // And it is no longer owed.
  assert.equal(await app.oldestUnfulfilledReport(user.id), null);
});

test("settling twice does not silently consume a second purchase", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const user = await seedUser(app);
  const first = await app.createReportEntitlement(user.id);
  await app.createReportEntitlement(user.id);

  assert.equal(await app.fulfilReportEntitlement(first, "s1", user.email, "<p>one</p>"), true);
  assert.equal(await app.fulfilReportEntitlement(first, "s2", user.email, "<p>two</p>"), false,
    "a settled claim must not be settled again");

  // The second purchase is still owed — two payments, two reports.
  const stillOwed = await app.oldestUnfulfilledReport(user.id);
  assert.ok(stillOwed, "the second purchase must remain claimable");
  assert.notEqual(stillOwed!.id, first);
});

test("an expired claim stops being auto-settled but stays listed", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const user = await seedUser(app);
  const id = await app.createReportEntitlement(user.id);
  await db.prepare("UPDATE report_entitlements SET expires_at=? WHERE id=?")
    .bind(Date.now() - 1000, id).run();

  assert.equal(await app.oldestUnfulfilledReport(user.id), null,
    "expired claims are not picked up automatically");
  const listed = await app.listReportEntitlements(user.id);
  assert.equal(listed.length, 1,
    "but the buyer must still see that they paid — money is never erased from view");
});

test("a report belongs to its buyer and nobody else", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const owner = await seedUser(app, "u1", "owner@example.com");
  await seedUser(app, "u2", "stranger@example.com");
  const id = await app.createReportEntitlement(owner.id);
  await app.fulfilReportEntitlement(id, "s1", owner.email, "<p>private</p>");

  assert.ok(await app.getReportEntitlement(id, "u1"));
  assert.equal(await app.getReportEntitlement(id, "u2"), null,
    "another account must not be able to read a purchased report");
});

test("a finished scan finds the buyer who is owed a report for that store", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const user = await seedUser(app);
  await app.createStore({
    id: "s1", userId: user.id, name: "Shop", storeUrl: "https://shop.example.com",
    wooKeyEnc: "k", wooSecretEnc: "s", plan: "free", status: "active",
    createdAt: Date.now(), updatedAt: Date.now(),
  });

  const found = await app.usersWithStoreUrl("https://shop.example.com");
  assert.deepEqual(found, [user.id]);
  assert.deepEqual(await app.usersWithStoreUrl("https://other.example.com"), []);
});
