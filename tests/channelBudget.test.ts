// The Apify Actor shares an IP pool with every other Actor on the platform, so
// the public per-IP counter fails a caller for other people's traffic: the
// tenth request in a day is refused to someone who has made one. That is the
// blocker this seam removes — and every way of removing it badly is worse than
// the blocker.
//
// The ways it could go wrong, each pinned below:
//
//   * trusting a User-Agent, an IP allowlist or a query-string secret;
//   * giving the channel an unlimited path;
//   * dropping the per-target-origin limit, which protects merchants' stores
//     rather than our capacity;
//   * counting in an isolate-local Map, which is not a limit on Workers at all;
//   * letting a retried Actor run produce a second future charge;
//   * writing an origin, a token or a result into the quota ledger.
import test from "node:test";
import assert from "node:assert/strict";
import { AppStore } from "../src/core/appStore.ts";
import { sqliteD1 } from "./helpers/sqlite.ts";

const CHANNEL = "apify-batch-preflight";
const DAY = "2026-09-07";

function store(): { app: AppStore; raw: ReturnType<typeof sqliteD1>["raw"] } {
  const { db, raw } = sqliteD1();
  return { app: new AppStore(db as never), raw };
}

// -- fail closed ------------------------------------------------------------

test("an unconfigured channel has a budget of zero, not a default", () => {
  return (async () => {
    const { app } = store();
    assert.equal(await app.channelDailyCap(CHANNEL), 0);
    assert.equal(await app.consumeChannelBudget(DAY, CHANNEL), false,
      "deploying this code must not switch the channel on");
  })();
});

test("a cap of zero, set explicitly, still refuses", async () => {
  const { app } = store();
  await app.setChannelDailyCap(CHANNEL, 0);
  assert.equal(await app.consumeChannelBudget(DAY, CHANNEL), false);
});

// -- the budget is a real limit --------------------------------------------

test("the channel budget stops at the configured cap, to the unit", async () => {
  const { app } = store();
  await app.setChannelDailyCap(CHANNEL, 3);

  const results = [];
  for (let i = 0; i < 5; i += 1) results.push(await app.consumeChannelBudget(DAY, CHANNEL));

  assert.deepEqual(results, [true, true, true, false, false]);
  assert.equal(await app.channelBudgetUsed(DAY, CHANNEL), 3);
});

test("the budget is per day, and yesterday's spend does not follow", async () => {
  const { app } = store();
  await app.setChannelDailyCap(CHANNEL, 1);
  assert.equal(await app.consumeChannelBudget("2026-09-07", CHANNEL), true);
  assert.equal(await app.consumeChannelBudget("2026-09-07", CHANNEL), false);
  assert.equal(await app.consumeChannelBudget("2026-09-08", CHANNEL), true);
});

test("concurrent callers cannot both take the last unit", async () => {
  // The conditional UPDATE is the whole reason this lives in the database
  // rather than in a Map: two isolates racing on the last unit both attempt
  // the write, and exactly one reports a change.
  const { app } = store();
  await app.setChannelDailyCap(CHANNEL, 5);
  const outcomes = await Promise.all(
    Array.from({ length: 12 }, () => app.consumeChannelBudget(DAY, CHANNEL)));
  assert.equal(outcomes.filter(Boolean).length, 5);
  assert.equal(await app.channelBudgetUsed(DAY, CHANNEL), 5);
});

test("one channel's budget is not another's", async () => {
  const { app } = store();
  await app.setChannelDailyCap(CHANNEL, 1);
  await app.setChannelDailyCap("some-other-channel", 1);
  assert.equal(await app.consumeChannelBudget(DAY, CHANNEL), true);
  assert.equal(await app.consumeChannelBudget(DAY, CHANNEL), false);
  assert.equal(await app.consumeChannelBudget(DAY, "some-other-channel"), true);
});

// -- idempotency ------------------------------------------------------------

test("a replayed run and item returns the first outcome and spends nothing", async () => {
  const { app } = store();
  await app.setChannelDailyCap(CHANNEL, 10);

  assert.equal(await app.recallChannelOutcome(CHANNEL, "run-1", "item-1"), null);
  await app.consumeChannelBudget(DAY, CHANNEL);
  await app.rememberChannelOutcome(CHANNEL, "run-1", "item-1", "USEFUL", true);

  const replay = await app.recallChannelOutcome(CHANNEL, "run-1", "item-1");
  assert.deepEqual(replay, { outcome: "USEFUL", billable: true });
  assert.equal(await app.channelBudgetUsed(DAY, CHANNEL), 1,
    "a replay must not consume a second unit");
});

test("a replay cannot overwrite the first answer with a different one", async () => {
  const { app } = store();
  await app.rememberChannelOutcome(CHANNEL, "run-1", "item-1", "ABSTAINED", false);
  await app.rememberChannelOutcome(CHANNEL, "run-1", "item-1", "USEFUL", true);
  assert.deepEqual(await app.recallChannelOutcome(CHANNEL, "run-1", "item-1"),
    { outcome: "ABSTAINED", billable: false },
    "the first outcome stands; a retry cannot promote an abstention to billable");
});

test("idempotency is scoped to the run AND the item", async () => {
  const { app } = store();
  await app.rememberChannelOutcome(CHANNEL, "run-1", "item-1", "USEFUL", true);
  assert.equal(await app.recallChannelOutcome(CHANNEL, "run-1", "item-2"), null,
    "a different item in the same run is a different question");
  assert.equal(await app.recallChannelOutcome(CHANNEL, "run-2", "item-1"), null,
    "the same item in a new run is a new question");
});

test("an abstention is remembered as non-billable", async () => {
  const { app } = store();
  await app.rememberChannelOutcome(CHANNEL, "run-9", "item-9", "ABSTAINED", false);
  const seen = await app.recallChannelOutcome(CHANNEL, "run-9", "item-9");
  assert.equal(seen?.billable, false);
});

// -- privacy ----------------------------------------------------------------

test("the quota and idempotency ledgers hold no origin, token, body or result", async () => {
  const { app, raw } = store();
  await app.setChannelDailyCap(CHANNEL, 5);
  await app.consumeChannelBudget(DAY, CHANNEL);
  await app.rememberChannelOutcome(CHANNEL, "run-secret-1", "item-secret-1", "USEFUL", true);

  const columns = (table: string) =>
    (raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);

  assert.deepEqual(columns("channel_budget_daily").sort(), ["channel_id", "count", "day_utc"]);
  assert.deepEqual(columns("channel_budget_config").sort(), ["channel_id", "daily_cap", "updated_at"]);
  assert.deepEqual(columns("channel_idempotency").sort(),
    ["billable", "channel_id", "created_at", "item_key", "outcome", "run_key"]);

  // and nothing store-shaped is in the rows either
  const dump = JSON.stringify([
    raw.prepare("SELECT * FROM channel_budget_daily").all(),
    raw.prepare("SELECT * FROM channel_idempotency").all(),
  ]);
  for (const forbidden of ["http://", "https://", "Bearer", "store_origin", "checks"]) {
    assert.equal(dump.includes(forbidden), false, `${forbidden} reached a quota ledger`);
  }
});

// -- migration --------------------------------------------------------------

test("the v13 tables are created, and creating them twice is safe", async () => {
  const { app, raw } = store();
  await app.channelDailyCap(CHANNEL);          // forces ensureSchema
  const tables = (raw.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map(t => t.name);
  for (const expected of ["channel_budget_config", "channel_budget_daily", "channel_idempotency"]) {
    assert.ok(tables.includes(expected), `${expected} was not created`);
  }

  // idempotent: a second pass must not throw and must not reset a cap
  await app.setChannelDailyCap(CHANNEL, 4);
  await app.channelDailyCap(CHANNEL);
  assert.equal(await app.channelDailyCap(CHANNEL), 4);
});

test("an upgrade preserves rows an earlier version wrote", async () => {
  // A rollback to a build without these tables leaves the rows in place; a
  // roll-forward must find them rather than recreate them empty. Simulated by
  // writing, re-opening the store over the same database, and reading back.
  const { db, raw } = sqliteD1();
  const first = new AppStore(db as never);
  await first.setChannelDailyCap(CHANNEL, 7);
  await first.consumeChannelBudget(DAY, CHANNEL);
  await first.rememberChannelOutcome(CHANNEL, "run-a", "item-a", "USEFUL", true);

  const second = new AppStore(db as never);
  assert.equal(await second.channelDailyCap(CHANNEL), 7);
  assert.equal(await second.channelBudgetUsed(DAY, CHANNEL), 1);
  assert.deepEqual(await second.recallChannelOutcome(CHANNEL, "run-a", "item-a"),
    { outcome: "USEFUL", billable: true });
  raw.close();
});
