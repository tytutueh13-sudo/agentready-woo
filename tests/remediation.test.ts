// Remediation regressions for the two High findings in
// docs/production/independent_review_part1_worker.md.
//
//   H-01  one failing operation must not abort the recovery/cleanup sweep
//   H-02  a ledger mismatch must halt new paid processing, authoritatively
//
// Durable on-disk SQLite ledger + a separate provider-effect database, exactly
// like recovery.test.ts. No network, no real payment.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type StatementSync, type SQLInputValue } from "node:sqlite";
import { D1FinancialStore, type D1DatabaseLike, type D1Result, type D1Rows, type D1Statement } from "../src/core/d1Store.ts";
import { RevenueGuard, type FaultInjector } from "../src/core/guard.ts";
import type { Authorization, PaymentProvider, PaymentRequirement, Settlement, SettlementLookup } from "../src/core/paymentProvider.ts";
import type { FinancialOperation, PaymentVerification, RequestContext } from "../src/core/types.ts";
import type { RevenueGuardConfig } from "../src/core/pricing.ts";

const PRODUCT_ID = "early-3426536d88daa242";

class SqliteStatement implements D1Statement {
  private statement: StatementSync; private args: SQLInputValue[] = [];
  constructor(statement: StatementSync) { this.statement = statement; }
  bind(...values: unknown[]): D1Statement { this.args = values as SQLInputValue[]; return this; }
  async run(): Promise<D1Result> { try { const out = this.statement.run(...this.args); return { success: true, meta: { changes: Number(out.changes) } }; } catch { return { success: false, meta: { changes: 0 } }; } }
  async first<T>(): Promise<T | null> { return (this.statement.get(...this.args) as T | undefined) ?? null; }
  async all<T>(): Promise<D1Rows<T>> { return { results: this.statement.all(...this.args) as T[] }; }
}
class SqliteD1 implements D1DatabaseLike {
  readonly raw: DatabaseSync;
  constructor(path: string) { this.raw = new DatabaseSync(path); this.raw.prepare("PRAGMA journal_mode=WAL").get(); this.raw.prepare("PRAGMA busy_timeout=5000").get(); }
  prepare(sql: string): D1Statement { return new SqliteStatement(this.raw.prepare(sql)); }
}
// Fails every statement touching one table, to prove a cleanup step failure
// does not skip the remaining cleanup steps.
class BrokenTableD1 implements D1DatabaseLike {
  private inner: SqliteD1; private broken: string;
  constructor(inner: SqliteD1, broken: string) { this.inner = inner; this.broken = broken; }
  prepare(sql: string): D1Statement {
    if (sql.startsWith("DELETE") && sql.includes(this.broken)) throw new Error(`simulated storage failure on ${this.broken}`);
    return this.inner.prepare(sql);
  }
}

class DurableProvider implements PaymentProvider {
  readonly movesRealMoney = true; private db: DatabaseSync; private loseResponse: boolean;
  authorizeCalls = 0; settleCalls = 0;
  constructor(path: string, loseResponse = false) {
    this.db = new DatabaseSync(path); this.loseResponse = loseResponse;
    this.db.prepare("CREATE TABLE IF NOT EXISTS effects(settlement_id TEXT PRIMARY KEY,amount REAL NOT NULL,payer TEXT NOT NULL)").run();
  }
  terms() { return { asset: "0xasset", network: "eip155:84532", payTo: "0xmerchant", scheme: "upto" as const }; }
  async authorizePayment(_r: string, maximum: number): Promise<Authorization> { this.authorizeCalls++; return { authorized: true, payer: "payer", maxAmount: maximum, reason: "" }; }
  async settlePayment(_r: string, actual: number, id: string): Promise<Settlement> {
    this.settleCalls++;
    this.db.prepare("INSERT OR IGNORE INTO effects VALUES(?,?,?)").run(id, actual, "payer");
    if (this.loseResponse) throw new Error("settlement response loss");
    return { settled: true, payer: "payer", amount: actual, transaction: id, reason: "", disposition: "SETTLED" };
  }
  async lookupSettlement(id: string): Promise<SettlementLookup> {
    const row = this.db.prepare("SELECT amount,payer FROM effects WHERE settlement_id=?").get(id) as { amount: number; payer: string } | undefined;
    return row ? { status: "SETTLED", payer: row.payer, amount: row.amount, transaction: id, reason: "" } : { status: "FINAL_FAILURE", payer: "", amount: 0, transaction: "", reason: "not found" };
  }
  effects(): number { return Number((this.db.prepare("SELECT COUNT(*) AS n FROM effects").get() as { n: number }).n); }
  exportPaymentProof(): unknown { return { accepted: { scheme: "upto" } }; }
  importPaymentProof(): boolean { return true; }
  async verifyPayment(reference: string): Promise<PaymentVerification> { return { status: "paid", amount: 1, payer: "payer", reference }; }
  async getPaymentAmount(): Promise<number> { return 1; }
  async getPayer(): Promise<string> { return "payer"; }
  async recordTransaction(): Promise<void> { }
}
class CrashAt implements FaultInjector {
  private point: string; constructor(point: string) { this.point = point; }
  checkpoint(name: string): void { if (name === this.point) throw new Error(`CRASH:${name}`); }
}

const config: RevenueGuardConfig = { minGrossMarginRatio: .7, minPriceMultiplier: 3, perRequestMaxCost: .5, dailyMaxCost: .5, monthlyMaxCost: .5, perUserDailyCost: .5, perProductDailyCost: .5, rateLimitWindowSeconds: 60, rateLimitMaxRequests: 100, circuitBreakerFailureThreshold: 3, circuitBreakerWindowSeconds: 60, circuitBreakerCooldownSeconds: 60, cacheDefaultTtlSeconds: 0 };
const ENV = { REAL_PAYMENTS_ENABLED: "true" };
function context(upstream: () => Promise<unknown>, requestId: string, productId = PRODUCT_ID): RequestContext {
  return { productId, identityKind: "api_key", identityValue: "user", authenticated: true, requestPayload: { q: requestId }, pricePerCall: .1, estimatedCost: .01, paymentReference: "proof", requestId, upstreamName: "upstream", upstream, actualCost: () => .005 };
}
function files(): { ledger: string; provider: string } {
  const dir = mkdtempSync(join(tmpdir(), "moneyai-remediation-"));
  return { ledger: join(dir, "ledger.db"), provider: join(dir, "provider.db") };
}
function guard(path: string, provider: PaymentProvider, faults: FaultInjector | null = null): RevenueGuard {
  return new RevenueGuard(new D1FinancialStore(new SqliteD1(path)), config, provider, ENV, undefined, faults);
}
// Mirrors src/index.ts::scheduled() — keep these two in step.
async function runCron(ledger: string, provider: PaymentProvider): Promise<void> {
  const store = new D1FinancialStore(new SqliteD1(ledger));
  const g = new RevenueGuard(store, config, provider, ENV);
  await store.recoverExpiredSafeReservations(Date.now() - 15 * 60 * 1000);
  await g.recoverPending(50);
  await g.reconcilePending(50);
  await store.purgeExpiredSensitiveData(Date.now());
}
function incidents(db: SqliteD1, operationId: string): string[] {
  return (db.raw.prepare("SELECT kind FROM financial_incidents WHERE operation_id=?").all(operationId) as { kind: string }[]).map(r => r.kind);
}

// ───────────────────────── H-01 ─────────────────────────

// A: a poisoned operation (no settlement outbox — the UPSTREAM_EFFECT_UNKNOWN
// path) scanned first must not strand the healthy obligation behind it.
test("H-01 A: a failing operation does not abort the sweep for the operation behind it", async () => {
  const f = files();
  let aCalls = 0, bCalls = 0;
  await assert.rejects(() => guard(f.ledger, new DurableProvider(f.provider), new CrashAt("after_upstream"))
    .processRequest(context(async () => { aCalls++; return { op: "A" }; }, "poison-request-0001")), /CRASH/);
  await guard(f.ledger, new DurableProvider(f.provider))
    .processRequest(context(async () => { aCalls++; return { op: "A" }; }, "poison-request-0001"));
  await new Promise(r => setTimeout(r, 5));
  await assert.rejects(() => guard(f.ledger, new DurableProvider(f.provider, true))
    .processRequest(context(async () => { bCalls++; return { op: "B" }; }, "healthy-request-0002")), /response loss/);

  const db = new SqliteD1(f.ledger);
  const store = new D1FinancialStore(db);
  assert.equal((await store.listRecoverableOperations(50))[0]?.requestId, "poison-request-0001");

  const provider = new DurableProvider(f.provider);
  const sweep = await new RevenueGuard(store, config, provider, ENV).recoverPending(50);

  const a = await store.getOperation("poison-request-0001");
  const b = await store.getOperation("healthy-request-0002");
  assert.equal(sweep.scanned, 2);
  assert.equal(a?.state, "RECOVERY_REQUIRED", "A stays fail-closed");
  assert.equal(a?.errorCode, "NO_SETTLEMENT_TRANSMITTED", "A is left in an explicit failure state");
  assert.ok(incidents(db, "poison-request-0001").includes("UNKNOWN_FINANCIAL_STATE"), "A is audited");
  assert.equal(b?.state, "RESULT_RELEASED", "B behind the poisoned operation is still recovered");
  assert.equal(provider.effects(), 1, "no duplicate settlement effect");
  assert.equal(aCalls, 1); assert.equal(bCalls, 1);
});

// B: a genuine mid-sweep exception is isolated, audited and quarantined, and
// every later operation is still processed.
test("H-01 B: a mid-sweep exception is quarantined and later operations still run", async () => {
  const f = files();
  const calls: string[] = [];
  for (const id of ["sweep-request-0001", "sweep-request-0002", "sweep-request-0003"]) {
    await assert.rejects(() => guard(f.ledger, new DurableProvider(f.provider, true))
      .processRequest(context(async () => { calls.push(id); return { id }; }, id)), /response loss/);
    await new Promise(r => setTimeout(r, 2));
  }
  const db = new SqliteD1(f.ledger);
  class ExplodingStore extends D1FinancialStore {
    async getEscrow(operationId: string) {
      if (operationId === "sweep-request-0002") throw new Error("simulated recovery exception");
      return super.getEscrow(operationId);
    }
  }
  const store = new ExplodingStore(db);
  const provider = new DurableProvider(f.provider);
  const sweep = await new RevenueGuard(store, config, provider, ENV).recoverPending(50);

  assert.equal(sweep.scanned, 3);
  assert.equal(sweep.failed, 1, "exactly the exploding operation is counted as failed");
  assert.equal((await store.getOperation("sweep-request-0001"))?.state, "RESULT_RELEASED");
  assert.equal((await store.getOperation("sweep-request-0003"))?.state, "RESULT_RELEASED",
    "the operation after the exception is still processed");
  const poisoned = await store.getOperation("sweep-request-0002");
  assert.equal(poisoned?.state, "RECOVERY_REQUIRED");
  assert.equal(poisoned?.errorCode, "RECOVERY_FAILED");
  assert.ok(incidents(db, "sweep-request-0002").includes("RECOVERY_FAILED"), "the failure is audited");
  assert.equal(provider.effects(), 3, "each obligation settles at most once");
});

// C: one failing cleanup step must not skip the remaining cleanup.
test("H-01 C: a failing purge step does not skip the rest of the cleanup", async () => {
  const f = files();
  const db = new SqliteD1(f.ledger);
  const store = new D1FinancialStore(db);
  const old = Date.now() - 3_600_000;
  await store.saveEscrow({ operationId: "released-expired", resultDigest: "d", payloadJson: "{}", payloadSize: 2, createdAt: old, expiresAt: old, releasedAt: old });
  db.raw.prepare("INSERT INTO payment_proofs VALUES('expired-proof','{}',2,?,?)").run(old, old);

  // payment_proofs cleanup fails; result_escrow cleanup must still happen.
  const broken = new D1FinancialStore(new BrokenTableD1(db, "payment_proofs"));
  const purged = await broken.purgeExpiredSensitiveData(Date.now());

  assert.equal(purged, 1, "the surviving cleanup step still reports its work");
  assert.equal(await store.getEscrow("released-expired"), null, "expired released escrow is still purged");
  assert.equal(Number((db.raw.prepare("SELECT COUNT(*) AS n FROM payment_proofs").get() as { n: number }).n), 1,
    "the failing step genuinely failed rather than being silently skipped");
});

// ───────────────────────── H-02 ─────────────────────────

async function haltedLedger(): Promise<{ f: { ledger: string; provider: string }; db: SqliteD1; upstreamCalls: () => number }> {
  const f = files();
  let calls = 0;
  const first = await guard(f.ledger, new DurableProvider(f.provider))
    .processRequest(context(async () => { calls++; return { value: 1 }; }, "halt-request-0001"));
  assert.equal(first.allowed, true);
  const db = new SqliteD1(f.ledger);
  db.raw.prepare("UPDATE usage SET cost=.009 WHERE request_id='halt-request-0001'").run();
  return { f, db, upstreamCalls: () => calls };
}

// A: mismatch -> halt -> a paid request is blocked before authorization.
test("H-02 A: a ledger mismatch halts the product before payment authorization", async () => {
  const { f, db } = await haltedLedger();
  const store = new D1FinancialStore(db);

  const reconciled = await new RevenueGuard(store, config, new DurableProvider(f.provider), ENV).reconcilePending(50);
  assert.equal(reconciled.mismatched, 1, "the scheduled reconciliation detects the mismatch");
  assert.equal(await store.isProductHalted(PRODUCT_ID), true);
  const halt = db.raw.prepare("SELECT product_id,reason,operation_id,created_at FROM financial_product_halts WHERE product_id=?").get(PRODUCT_ID) as { product_id: string; reason: string; operation_id: string; created_at: number };
  assert.equal(halt.product_id, PRODUCT_ID);
  assert.equal(halt.operation_id, "halt-request-0001");
  assert.equal(halt.reason, "FINANCIAL_LEDGER_MISMATCH");
  assert.ok(halt.created_at > 0);

  let upstream = 0;
  const provider = new DurableProvider(f.provider);
  const blocked = await guard(f.ledger, provider)
    .processRequest(context(async () => { upstream++; return { value: 2 }; }, "halt-request-0002"));

  assert.equal(blocked.allowed, false);
  assert.equal(blocked.stageReached, "kill_switch");
  assert.match(blocked.reason, /halted by financial reconciliation/);
  assert.equal(upstream, 0, "no upstream call after halt");
  assert.equal(provider.authorizeCalls, 0, "blocked before payment authorization");
  assert.equal(provider.settleCalls, 0);
});

// B: a halt on one product must not block a different product.
test("H-02 B: a halted product does not block a healthy product", async () => {
  const { f, db } = await haltedLedger();
  const store = new D1FinancialStore(db);
  await new RevenueGuard(store, config, new DurableProvider(f.provider), ENV).reconcilePending(50);
  assert.equal(await store.isProductHalted(PRODUCT_ID), true);
  assert.equal(await store.isProductHalted("other-product"), false);

  let upstream = 0;
  const healthy = await guard(f.ledger, new DurableProvider(f.provider))
    .processRequest(context(async () => { upstream++; return { value: 3 }; }, "healthy-product-0001", "other-product"));

  assert.equal(healthy.allowed, true, "the healthy product still serves");
  assert.equal(upstream, 1);
});

// C: after a halt, an existing obligation may still be reconciled/recovered —
// halting blocks NEW exposure, not the discharge of obligations already created.
test("H-02 C: existing obligation recovery still works while the product is halted", async () => {
  const f = files();
  let calls = 0;
  const upstream = async () => { calls++; return { value: 4 }; };
  await assert.rejects(() => guard(f.ledger, new DurableProvider(f.provider, true))
    .processRequest(context(upstream, "obligation-0001")), /response loss/);

  const db = new SqliteD1(f.ledger);
  const store = new D1FinancialStore(db);
  db.raw.prepare("INSERT OR IGNORE INTO financial_product_halts(product_id,reason,operation_id,created_at) VALUES(?,?,?,?)")
    .run(PRODUCT_ID, "manual halt for test", "obligation-0001", Date.now());
  assert.equal(await store.isProductHalted(PRODUCT_ID), true);

  const provider = new DurableProvider(f.provider);
  const replay = await guard(f.ledger, provider).processRequest(context(upstream, "obligation-0001"));

  assert.equal(replay.allowed, true, "the existing obligation is still discharged");
  assert.deepEqual(replay.result, { value: 4 });
  assert.equal(calls, 1, "no new upstream exposure");
  assert.equal(provider.effects(), 1, "no duplicate settlement");

  // ...but a NEW request on the halted product is still refused.
  let fresh = 0;
  const refused = await guard(f.ledger, new DurableProvider(f.provider))
    .processRequest(context(async () => { fresh++; return { value: 5 }; }, "obligation-0002"));
  assert.equal(refused.allowed, false);
  assert.equal(refused.stageReached, "kill_switch");
  assert.equal(fresh, 0);
});

// D: a long-lived Worker/provider instance built before the halt must still
// block, i.e. the halt is re-read authoritatively rather than cached.
test("H-02 D: a stale Worker instance created before the halt still blocks", async () => {
  const f = files();
  const provider = new DurableProvider(f.provider);
  const store = new D1FinancialStore(new SqliteD1(f.ledger));
  const staleGuard = new RevenueGuard(store, config, provider, ENV);   // built first

  let upstream = 0;
  const ok = await staleGuard.processRequest(context(async () => { upstream++; return { value: 6 }; }, "stale-request-0001"));
  assert.equal(ok.allowed, true);
  assert.equal(upstream, 1);

  // Halt happens after the instance exists, through a different connection.
  const other = new SqliteD1(f.ledger);
  other.raw.prepare("UPDATE usage SET cost=.009 WHERE request_id='stale-request-0001'").run();
  const mismatch = await new D1FinancialStore(other).reconcileOperation("stale-request-0001");
  assert.equal(mismatch.ok, false);

  const authorizeBefore = provider.authorizeCalls;
  const blocked = await staleGuard.processRequest(context(async () => { upstream++; return { value: 7 }; }, "stale-request-0002"));

  assert.equal(blocked.allowed, false, "the pre-existing instance re-reads the halt");
  assert.equal(blocked.stageReached, "kill_switch");
  assert.equal(upstream, 1, "no further upstream call");
  assert.equal(provider.authorizeCalls, authorizeBefore, "blocked before authorization");
});

// The halt is never cleared automatically by any runtime path.
test("H-02: no runtime path clears a financial halt", async () => {
  const { f, db } = await haltedLedger();
  const store = new D1FinancialStore(db);
  await new RevenueGuard(store, config, new DurableProvider(f.provider), ENV).reconcilePending(50);
  assert.equal(await store.isProductHalted(PRODUCT_ID), true);
  for (let n = 0; n < 3; n++) await runCron(f.ledger, new DurableProvider(f.provider));
  assert.equal(await store.isProductHalted(PRODUCT_ID), true, "cron never auto-releases a halt");
});

// End-to-end: the exact independent-review reproducer, now closed.
test("H-01+H-02: the scheduled cron body halts a corrupted ledger and blocks the next paid request", async () => {
  const { f, db } = await haltedLedger();
  const store = new D1FinancialStore(db);

  await runCron(f.ledger, new DurableProvider(f.provider));

  assert.equal(await store.isProductHalted(PRODUCT_ID), true, "the real cron body halts the product");
  let upstream = 0;
  const next = await guard(f.ledger, new DurableProvider(f.provider))
    .processRequest(context(async () => { upstream++; return { value: 9 }; }, "post-halt-0001"));
  assert.equal(next.allowed, false);
  assert.equal(next.stageReached, "kill_switch");
  assert.equal(upstream, 0);
});
