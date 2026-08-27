// App-side persistence (accounts, sessions, stores, scans). Deliberately
// separate from D1FinancialStore: the financial ledger has its own strict
// checksummed migration path and must never be entangled with SaaS tables.
export interface AppD1Statement { bind(...values: unknown[]): AppD1Statement; run(): Promise<{ success: boolean; meta?: { changes?: number } }>; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; }
export interface AppD1Database { prepare(sql: string): AppD1Statement; }

export type PlanKey = "free" | "pro" | "agency";

export interface UserRow { id: string; email: string; passwordHash: string; createdAt: number; }
export interface SessionRow { tokenHash: string; userId: string; createdAt: number; expiresAt: number; }
export interface StoreRow {
  id: string; userId: string; name: string; storeUrl: string;
  wooKeyEnc: string; wooSecretEnc: string;
  plan: PlanKey; status: string; createdAt: number; updatedAt: number;
}
export interface ScanRow { id: string; storeUrl: string; score: number; resultJson: string; createdAt: number; }

// Primary-evidence funnel: the four moments that separate "somebody looked"
// from "somebody paid". Written on the request path that already exists for
// each moment (no client JS, no beacon) so a JS-disabled or blocked visitor
// is still counted. See docs/market — this table is what lets a future
// revenue-evidence judgment cite this product's own funnel instead of only
// competitor pricing pages.
export type FunnelEventKind = "scan_completed" | "wall_shown" | "checkout_started" | "checkout_completed";
export interface FunnelEventRow {
  id: string; kind: FunnelEventKind; storeId: string | null; userId: string | null;
  plan: string | null; metaJson: string; createdAt: number;
}

// Password reset: an opaque, single-use, short-lived token — same hash-only-
// at-rest pattern as sessions (see auth.ts). The raw token lives only in the
// emailed link; the row is dead weight (never resurrected) once `usedAt` is
// set or `expiresAt` passes, so the "did this user already reset?" check is
// always a fresh row, not a mutable flag someone could race.
export interface PasswordResetRow {
  id: string; userId: string; tokenHash: string;
  createdAt: number; expiresAt: number; usedAt: number | null;
}

// One row per Paddle webhook event that changed billing state — the
// merchant-facing "billing history" reads this instead of re-deriving it
// from `stores.plan`, which only ever holds the current plan, not how it
// got there.
export type BillingEventType = "activated" | "updated" | "canceled" | "past_due" | "report_purchase";
export interface BillingEventRow {
  id: string; userId: string; eventType: BillingEventType; plan: string | null;
  amount: string | null; currency: string | null; occurredAt: number; rawJson: string;
}

const APP_SCHEMA_VERSION = 3;
const APP_MIGRATION_NAME = "app_saas_baseline_v3";
const APP_TABLES: [string, string][] = [
  ["users", "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL)"],
  ["sessions", "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)"],
  ["stores", "CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, store_url TEXT NOT NULL, woo_key_enc TEXT NOT NULL, woo_secret_enc TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free','pro','agency')), status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"],
  ["scan_results", "CREATE TABLE IF NOT EXISTS scan_results (id TEXT PRIMARY KEY, store_url TEXT NOT NULL, score INTEGER NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL)"],
  ["funnel_events", "CREATE TABLE IF NOT EXISTS funnel_events (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('scan_completed','wall_shown','checkout_started','checkout_completed')), store_id TEXT, user_id TEXT, plan TEXT, meta_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)"],
  ["password_resets", "CREATE TABLE IF NOT EXISTS password_resets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)"],
  ["billing_events", "CREATE TABLE IF NOT EXISTS billing_events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN ('activated','updated','canceled','past_due','report_purchase')), plan TEXT, amount TEXT, currency TEXT, occurred_at INTEGER NOT NULL, raw_json TEXT NOT NULL DEFAULT '{}')"],
  ["digest_sends", "CREATE TABLE IF NOT EXISTS digest_sends (user_id TEXT PRIMARY KEY, last_sent_at INTEGER NOT NULL)"],
];
const APP_INDEXES: string[] = [
  "CREATE INDEX IF NOT EXISTS funnel_events_kind_idx ON funnel_events(kind, created_at)",
  "CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets(user_id, created_at)",
  "CREATE INDEX IF NOT EXISTS scan_results_store_url_idx ON scan_results(store_url, created_at)",
  "CREATE INDEX IF NOT EXISTS billing_events_user_idx ON billing_events(user_id, occurred_at)",
];

type Row = Record<string, unknown>;

export class AppStore {
  private db: AppD1Database;
  private schemaReady = false;
  constructor(db: AppD1Database) { this.db = db; }

  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    const metadata = "CREATE TABLE IF NOT EXISTS app_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL)";
    const metaRun = await this.db.prepare(metadata).run();
    if (!metaRun.success) throw new Error("app schema metadata initialization failed");
    const canonical = (sql: string) => sql.toLowerCase().replace(/create\s+table\s+if\s+not\s+exists/g, "create table").replace(/[\s`"'\[\]]/g, "");
    const checksum = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(APP_TABLES.map(([n, s]) => `${n}:${canonical(s)}`).join("\n")))))
      .map(v => v.toString(16).padStart(2, "0")).join("");
    const recorded = await this.db.prepare("SELECT version,name,checksum FROM app_schema_migrations WHERE version=?")
      .bind(APP_SCHEMA_VERSION).first<{ version: number; name: string; checksum: string }>();
    const placeholders = APP_TABLES.map(() => "?").join(",");
    const existing = await this.db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN (${placeholders})`)
      .bind(...APP_TABLES.map(([n]) => n)).all<SchemaRowLite>();
    const have = new Map(existing.results.map(r => [r.name, r.sql ?? ""]));
    if (!recorded) {
      // Every table gets an idempotent CREATE TABLE IF NOT EXISTS, whether it
      // already existed or not — this is what lets a *new* table (added here
      // after a prior version was already applied) actually get created, not
      // just checked for drift. Drift is still checked for tables that
      // already existed under a different definition.
      const drifted = APP_TABLES.some(([n, s]) => have.has(n) && canonical(have.get(n) ?? "") !== canonical(s));
      if (drifted) throw new Error("app baseline adoption refused: existing schema differs");
      for (const [, sql] of APP_TABLES) {
        const r = await this.db.prepare(sql).run();
        if (!r.success) throw new Error("app baseline migration failed");
      }
      const ins = await this.db.prepare("INSERT OR IGNORE INTO app_schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)")
        .bind(APP_SCHEMA_VERSION, APP_MIGRATION_NAME, checksum, Date.now()).run();
      if (!ins.success) throw new Error("app baseline migration record failed");
    } else if (recorded.name !== APP_MIGRATION_NAME || recorded.checksum !== checksum) {
      throw new Error("app schema version or checksum mismatch");
    }
    for (const sql of APP_INDEXES) {
      const r = await this.db.prepare(sql).run();
      if (!r.success) throw new Error("app schema index creation failed");
    }
    this.schemaReady = true;
  }

  async createUser(id: string, email: string, passwordHash: string): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.db.prepare("INSERT OR IGNORE INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)")
      .bind(id, email.toLowerCase(), passwordHash, Date.now()).run();
    return r.success && (r.meta?.changes ?? 0) === 1;
  }
  async getUserByEmail(email: string): Promise<UserRow | null> {
    await this.ensureSchema();
    const r = await this.db.prepare("SELECT id,email,password_hash,created_at FROM users WHERE email=?")
      .bind(email.toLowerCase()).first<Row>();
    return r ? { id: String(r.id), email: String(r.email), passwordHash: String(r.password_hash), createdAt: Number(r.created_at) } : null;
  }
  async getUser(id: string): Promise<UserRow | null> {
    await this.ensureSchema();
    const r = await this.db.prepare("SELECT id,email,password_hash,created_at FROM users WHERE id=?").bind(id).first<Row>();
    return r ? { id: String(r.id), email: String(r.email), passwordHash: String(r.password_hash), createdAt: Number(r.created_at) } : null;
  }
  async updateUserPassword(id: string, passwordHash: string): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.db.prepare("UPDATE users SET password_hash=? WHERE id=?").bind(passwordHash, id).run();
    return r.success && (r.meta?.changes ?? 0) === 1;
  }
  /** false on a duplicate email — the caller (never this method) decides
   * whether that's "someone else already has it" or "no change needed". */
  async updateUserEmail(id: string, email: string): Promise<boolean> {
    await this.ensureSchema();
    try {
      const r = await this.db.prepare("UPDATE users SET email=? WHERE id=?").bind(email.toLowerCase(), id).run();
      return r.success && (r.meta?.changes ?? 0) === 1;
    } catch {
      return false;
    }
  }
  /** Cascades to sessions and stores — "delete my account" means the
   * account's data leaves too, not an orphaned stores table. Funnel/billing
   * history rows are left in place (aggregate evidence, not personal data
   * the merchant is asking to see deleted) but are keyed by a user_id that
   * no longer resolves to anyone, same as an ordinary retention policy.
   */
  async deleteUser(id: string): Promise<void> {
    await this.ensureSchema();
    await this.deleteAllSessionsForUser(id);
    await this.db.prepare("DELETE FROM stores WHERE user_id=?").bind(id).run();
    await this.db.prepare("DELETE FROM password_resets WHERE user_id=?").bind(id).run();
    await this.db.prepare("DELETE FROM users WHERE id=?").bind(id).run();
  }
  /** Admin list — newest first, paginated. Deliberately no search/filter
   * yet; the operator surface this backs is read-only and small-scale. */
  async listUsers(limit = 100, offset = 0): Promise<UserRow[]> {
    await this.ensureSchema();
    const rows = await this.db.prepare("SELECT id,email,password_hash,created_at FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .bind(limit, offset).all<Row>();
    return rows.results.map(r => ({ id: String(r.id), email: String(r.email), passwordHash: String(r.password_hash), createdAt: Number(r.created_at) }));
  }
  async countUsers(): Promise<number> {
    await this.ensureSchema();
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  async createSession(s: SessionRow): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.db.prepare("INSERT OR REPLACE INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)")
      .bind(s.tokenHash, s.userId, s.createdAt, s.expiresAt).run();
    return r.success;
  }
  async getSession(tokenHash: string): Promise<SessionRow | null> {
    await this.ensureSchema();
    const r = await this.db.prepare("SELECT token_hash,user_id,created_at,expires_at FROM sessions WHERE token_hash=? AND expires_at>?")
      .bind(tokenHash, Date.now()).first<Row>();
    return r ? { tokenHash: String(r.token_hash), userId: String(r.user_id), createdAt: Number(r.created_at), expiresAt: Number(r.expires_at) } : null;
  }
  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.prepare("DELETE FROM sessions WHERE token_hash=?").bind(tokenHash).run();
  }
  /** A password reset (or "delete my account") invalidates every session
   * for that user, not just the one making the request — the premise of a
   * reset is that some OTHER session might not be trustworthy. */
  async deleteAllSessionsForUser(userId: string): Promise<void> {
    await this.ensureSchema();
    await this.db.prepare("DELETE FROM sessions WHERE user_id=?").bind(userId).run();
  }

  async createStore(s: StoreRow): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.db.prepare("INSERT OR IGNORE INTO stores(id,user_id,name,store_url,woo_key_enc,woo_secret_enc,plan,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .bind(s.id, s.userId, s.name, s.storeUrl, s.wooKeyEnc, s.wooSecretEnc, s.plan, s.status, s.createdAt, s.updatedAt).run();
    return r.success && (r.meta?.changes ?? 0) === 1;
  }
  async listStores(userId: string): Promise<StoreRow[]> {
    await this.ensureSchema();
    const rows = await this.db.prepare("SELECT * FROM stores WHERE user_id=? ORDER BY created_at").bind(userId).all<Row>();
    return rows.results.map(r => this.store(r));
  }
  async getStore(id: string): Promise<StoreRow | null> {
    await this.ensureSchema();
    const r = await this.db.prepare("SELECT * FROM stores WHERE id=?").bind(id).first<Row>();
    return r ? this.store(r) : null;
  }
  async getStoreForUser(id: string, userId: string): Promise<StoreRow | null> {
    await this.ensureSchema();
    const r = await this.db.prepare("SELECT * FROM stores WHERE id=? AND user_id=?").bind(id, userId).first<Row>();
    return r ? this.store(r) : null;
  }
  async updateStoreCredentials(id: string, userId: string, name: string, storeUrl: string, keyEnc: string, secretEnc: string): Promise<boolean> {
    const r = await this.db.prepare("UPDATE stores SET name=?,store_url=?,woo_key_enc=?,woo_secret_enc=?,updated_at=? WHERE id=? AND user_id=?")
      .bind(name, storeUrl, keyEnc, secretEnc, Date.now(), id, userId).run();
    return r.success && (r.meta?.changes ?? 0) === 1;
  }
  async setStorePlan(id: string, plan: PlanKey): Promise<boolean> {
    const r = await this.db.prepare("UPDATE stores SET plan=?,updated_at=? WHERE id=?").bind(plan, Date.now(), id).run();
    return r.success && (r.meta?.changes ?? 0) === 1;
  }
  async setStorePlanByUser(userId: string, plan: PlanKey): Promise<number> {
    const r = await this.db.prepare("UPDATE stores SET plan=?,updated_at=? WHERE user_id=?").bind(plan, Date.now(), userId).run();
    return r.success ? (r.meta?.changes ?? 0) : 0;
  }
  async countUserStores(userId: string): Promise<number> {
    await this.ensureSchema();
    const r = await this.db.prepare("SELECT COUNT(*) AS n FROM stores WHERE user_id=?").bind(userId).first<{ n: number }>();
    return Number(r?.n ?? 0);
  }

  async saveScan(s: ScanRow): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.db.prepare("INSERT OR REPLACE INTO scan_results(id,store_url,score,result_json,created_at) VALUES(?,?,?,?,?)")
      .bind(s.id, s.storeUrl, s.score, s.resultJson, s.createdAt).run();
    return r.success;
  }
  async getScan(id: string): Promise<ScanRow | null> {
    await this.ensureSchema();
    const r = await this.db.prepare("SELECT * FROM scan_results WHERE id=?").bind(id).first<Row>();
    return r ? { id: String(r.id), storeUrl: String(r.store_url), score: Number(r.score), resultJson: String(r.result_json), createdAt: Number(r.created_at) } : null;
  }
  async getLatestScanForStoreUrl(storeUrl: string): Promise<ScanRow | null> {
    await this.ensureSchema();
    const r = await this.db.prepare("SELECT * FROM scan_results WHERE store_url=? ORDER BY created_at DESC LIMIT 1").bind(storeUrl).first<Row>();
    return r ? { id: String(r.id), storeUrl: String(r.store_url), score: Number(r.score), resultJson: String(r.result_json), createdAt: Number(r.created_at) } : null;
  }

  // --- weekly digest -----------------------------------------------------
  /** A user is "due" once they have at least one store and either never got
   * a digest or their last one was before `sinceMs` — one query covers both
   * cases so a first-time send and a repeat send use the same path. */
  /** Paid plans only (a Pro/Agency store) — this is a paid-tier perk, not
   * a free-tier feature, so a free user with a store connected is not
   * "due" here. */
  async usersDueForDigest(sinceMs: number, limit = 50): Promise<{ id: string; email: string }[]> {
    await this.ensureSchema();
    const rows = await this.db.prepare(
      `SELECT u.id AS id, u.email AS email FROM users u
       WHERE EXISTS (SELECT 1 FROM stores s WHERE s.user_id = u.id AND s.plan != 'free')
       AND NOT EXISTS (SELECT 1 FROM digest_sends d WHERE d.user_id = u.id AND d.last_sent_at > ?)
       LIMIT ?`,
    ).bind(sinceMs, limit).all<Row>();
    return rows.results.map(r => ({ id: String(r.id), email: String(r.email) }));
  }
  async markDigestSent(userId: string, atMs: number): Promise<void> {
    await this.ensureSchema();
    await this.db.prepare("INSERT INTO digest_sends(user_id,last_sent_at) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET last_sent_at=excluded.last_sent_at")
      .bind(userId, atMs).run();
  }

  /** Best-effort: a funnel write must never break the request it is
   * observing. Callers fire-and-forget or await without checking the
   * return value for anything other than logging. */
  async recordFunnelEvent(e: {
    kind: FunnelEventKind; storeId?: string | null; userId?: string | null;
    plan?: string | null; meta?: Record<string, unknown>;
  }): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.db.prepare(
      "INSERT INTO funnel_events(id,kind,store_id,user_id,plan,meta_json,created_at) VALUES(?,?,?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(), e.kind, e.storeId ?? null, e.userId ?? null, e.plan ?? null,
      JSON.stringify(e.meta ?? {}), Date.now(),
    ).run();
    return r.success;
  }

  // --- password reset -----------------------------------------------
  async createPasswordReset(userId: string, tokenHash: string, ttlMs: number): Promise<boolean> {
    await this.ensureSchema();
    const now = Date.now();
    const r = await this.db.prepare(
      "INSERT INTO password_resets(id,user_id,token_hash,created_at,expires_at,used_at) VALUES(?,?,?,?,?,NULL)",
    ).bind(crypto.randomUUID(), userId, tokenHash, now, now + ttlMs).run();
    return r.success;
  }
  /** Valid means: exists, unexpired, unused — all three, every time. */
  async getValidPasswordReset(tokenHash: string): Promise<PasswordResetRow | null> {
    await this.ensureSchema();
    const r = await this.db.prepare(
      "SELECT * FROM password_resets WHERE token_hash=? AND used_at IS NULL AND expires_at>?",
    ).bind(tokenHash, Date.now()).first<Row>();
    return r ? this.passwordReset(r) : null;
  }
  /** Marks used AND only succeeds once — a second call (double-submit,
   * replay) affects zero rows instead of silently "succeeding" twice. */
  async consumePasswordReset(tokenHash: string): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.db.prepare(
      "UPDATE password_resets SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?",
    ).bind(Date.now(), tokenHash, Date.now()).run();
    return r.success && (r.meta?.changes ?? 0) === 1;
  }
  async latestPasswordReset(userId: string): Promise<PasswordResetRow | null> {
    await this.ensureSchema();
    const r = await this.db.prepare(
      "SELECT * FROM password_resets WHERE user_id=? ORDER BY created_at DESC LIMIT 1",
    ).bind(userId).first<Row>();
    return r ? this.passwordReset(r) : null;
  }

  // --- billing history -------------------------------------------------
  async recordBillingEvent(e: {
    userId: string; eventType: BillingEventType; plan?: string | null;
    amount?: string | null; currency?: string | null; raw?: unknown;
  }): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.db.prepare(
      "INSERT INTO billing_events(id,user_id,event_type,plan,amount,currency,occurred_at,raw_json) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(), e.userId, e.eventType, e.plan ?? null, e.amount ?? null, e.currency ?? null,
      Date.now(), JSON.stringify(e.raw ?? {}),
    ).run();
    return r.success;
  }
  async listBillingEvents(userId: string, limit = 50): Promise<BillingEventRow[]> {
    await this.ensureSchema();
    const rows = await this.db.prepare(
      "SELECT * FROM billing_events WHERE user_id=? ORDER BY occurred_at DESC LIMIT ?",
    ).bind(userId, limit).all<Row>();
    return rows.results.map(r => this.billingEvent(r));
  }

  /** Counts per funnel stage since `sinceMs` — the primary-evidence read
   * side. Ordered by the funnel's natural sequence, not alphabetically,
   * so a caller can print it directly as a drop-off ladder. */
  async funnelSummary(sinceMs: number): Promise<{ kind: FunnelEventKind; count: number }[]> {
    await this.ensureSchema();
    const rows = await this.db.prepare(
      "SELECT kind, COUNT(*) AS n FROM funnel_events WHERE created_at>=? GROUP BY kind",
    ).bind(sinceMs).all<{ kind: FunnelEventKind; n: number }>();
    const counts = new Map(rows.results.map(r => [r.kind, Number(r.n)]));
    const order: FunnelEventKind[] = ["scan_completed", "wall_shown", "checkout_started", "checkout_completed"];
    return order.map(kind => ({ kind, count: counts.get(kind) ?? 0 }));
  }

  private store(r: Row): StoreRow {
    return {
      id: String(r.id), userId: String(r.user_id), name: String(r.name), storeUrl: String(r.store_url),
      wooKeyEnc: String(r.woo_key_enc), wooSecretEnc: String(r.woo_secret_enc),
      plan: String(r.plan) as PlanKey, status: String(r.status),
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    };
  }
  private passwordReset(r: Row): PasswordResetRow {
    return {
      id: String(r.id), userId: String(r.user_id), tokenHash: String(r.token_hash),
      createdAt: Number(r.created_at), expiresAt: Number(r.expires_at),
      usedAt: r.used_at === null || r.used_at === undefined ? null : Number(r.used_at),
    };
  }
  private billingEvent(r: Row): BillingEventRow {
    return {
      id: String(r.id), userId: String(r.user_id), eventType: String(r.event_type) as BillingEventType,
      plan: r.plan === null || r.plan === undefined ? null : String(r.plan),
      amount: r.amount === null || r.amount === undefined ? null : String(r.amount),
      currency: r.currency === null || r.currency === undefined ? null : String(r.currency),
      occurredAt: Number(r.occurred_at), rawJson: String(r.raw_json),
    };
  }
}

interface SchemaRowLite { name: string; sql: string | null; }

export const PLAN_OFFER_LIMITS: Record<PlanKey, number> = { free: 10, pro: -1, agency: -1 };
export const PLAN_STORE_LIMITS: Record<PlanKey, number> = { free: 1, pro: 1, agency: 25 };
export function offerLimitFor(plan: PlanKey): number { return PLAN_OFFER_LIMITS[plan] ?? 10; }
export function storeLimitFor(plan: PlanKey): number { return PLAN_STORE_LIMITS[plan] ?? 1; }
