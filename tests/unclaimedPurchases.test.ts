// A payment that lands under an address with no account must not vanish.
//
// Paddle's checkout lets the buyer edit their email before paying, so this
// is ordinary rather than an edge case. The webhook used to answer HTTP 200
// with `{ ignored: "unknown user" }` — Paddle reads that as delivered and
// never retries, so the charge went through and nothing recorded it. These
// tests pin the replacement: the purchase is held, the right tier is handed
// over exactly once, and nobody else can collect it.
import test from "node:test";
import assert from "node:assert/strict";
import { AppStore } from "../src/core/appStore.ts";
import { claimPurchases, type PaddleEnv } from "../src/webhooks.ts";
import { sqliteD1 } from "./helpers/sqlite.ts";

const PRICE_PRO = "pri_fixture_pro";
const PRICE_REPORT = "pri_fixture_report";
const PRICE_AGENCY = "pri_fixture_agency";
const BUYER = "buyer@example.com";
const env = {
  PADDLE_PRICE_PRO: PRICE_PRO, PADDLE_PRICE_REPORT: PRICE_REPORT,
  PADDLE_PRICE_AGENCY: PRICE_AGENCY,
} as unknown as PaddleEnv;

async function seed(app: AppStore, email = BUYER, userId = "u1") {
  await app.createUser(userId, email, "hash");
  await app.createStore({
    id: `s-${userId}`, userId, name: "Shop", storeUrl: `https://${userId}.example.com`,
    wooKeyEnc: "k", wooSecretEnc: "s", plan: "free", status: "active",
    createdAt: Date.now(), updatedAt: Date.now(),
  });
  return userId;
}

async function hold(app: AppStore, priceId: string, txn = "txn_1", email = BUYER) {
  return app.recordUnclaimedPurchase({
    transactionId: txn, email, priceId, amount: "49.00", currency: "USD",
  });
}

test("a payment under an unknown address is held, not dropped", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  assert.equal(await hold(app, PRICE_PRO), true);
  assert.equal((await app.unclaimedPurchasesFor(BUYER)).length, 1);
});

test("Paddle's transaction id makes a webhook retry idempotent", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  assert.equal(await hold(app, PRICE_PRO, "txn_1"), true);
  assert.equal(await hold(app, PRICE_PRO, "txn_1"), false);
  assert.equal((await app.unclaimedPurchasesFor(BUYER)).length, 1);
});

test("signing in with that address activates the Pro that was paid for", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await hold(app, PRICE_PRO);
  const userId = await seed(app);

  assert.equal(await claimPurchases(app, env, userId, BUYER), 1);

  const stores = await app.listStores(userId);
  assert.equal(stores[0].plan, "pro");
  assert.equal((await app.unclaimedPurchasesFor(BUYER)).length, 0);
});

test("a held report purchase becomes a claimable report, not a lost email", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await hold(app, PRICE_REPORT);
  const userId = await seed(app);

  assert.equal(await claimPurchases(app, env, userId, BUYER), 1);

  const reports = await app.listReportEntitlements(userId);
  assert.equal(reports.length, 1, "the buyer must end up owning a report");
  // No scan exists yet, so it stays owed rather than being silently consumed.
  assert.ok(await app.oldestUnfulfilledReport(userId));
});

test("claiming twice does not hand out the tier twice", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await hold(app, PRICE_PRO);
  const userId = await seed(app);

  assert.equal(await claimPurchases(app, env, userId, BUYER), 1);
  assert.equal(await claimPurchases(app, env, userId, BUYER), 0);
  assert.equal((await app.listBillingEvents(userId)).length, 1);
});

test("a price we do not sell hands out nothing", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await hold(app, "pri_someone_elses_product");
  const userId = await seed(app);

  assert.equal(await claimPurchases(app, env, userId, BUYER), 0);
  const stores = await app.listStores(userId);
  assert.equal(stores[0].plan, "free");
});

test("one buyer's payment cannot be collected by another address", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await hold(app, PRICE_PRO);
  const stranger = await seed(app, "stranger@example.com", "u2");

  assert.equal(await claimPurchases(app, env, stranger, "stranger@example.com"), 0);
  assert.equal((await app.unclaimedPurchasesFor(BUYER)).length, 1,
    "the real buyer's claim must survive untouched");
});

test("the address is matched case-insensitively", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await hold(app, PRICE_PRO, "txn_1", "Buyer@Example.COM");
  const userId = await seed(app);
  assert.equal(await claimPurchases(app, env, userId, BUYER), 1);
});
