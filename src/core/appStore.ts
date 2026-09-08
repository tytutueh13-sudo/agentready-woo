// App-side persistence (accounts, sessions, stores, scans). Deliberately
// separate from D1FinancialStore: the financial ledger has its own strict
// checksummed migration path and must never be entangled with SaaS tables.
export interface AppD1Statement { bind(...values: unknown[]): AppD1Statement; run(): Promise<{ success: boolean; meta?: { changes?: number } }>; first<T>(): Promise<T | null>; all<T>(): Promise<{ results: T[] }>; }
export interface AppD1Database { prepare(sql: string): AppD1Statement; }

import {
  USAGE_CHANNELS, USAGE_OUTCOMES, USAGE_SURFACES,
  type UsageChannel, type UsageOutcome, type UsageSurface,
} from "./usage.ts";

export type PlanKey = "free" | "pro" | "agency";

export interface UserRow { id: string; email: string; passwordHash: string; createdAt: number; }
export interface SessionRow { tokenHash: string; userId: string; createdAt: number; expiresAt: number; }
export interface StoreRow {
  id: string; userId: string; name: string; storeUrl: string;
  wooKeyEnc: string; wooSecretEnc: string;
  plan: PlanKey; status: string; createdAt: number; updatedAt: number;
}
export interface ScanRow { id: string; storeUrl: string; score: number; resultJson: string; createdAt: number; }
export interface ReleaseGateRunRow { id: string; accountId: string; storeId: string; mode: "owned-safe-active"; requestedFamiliesJson: string; baselineRunId: string | null; idempotencyKey: string; state: "QUEUED" | "RUNNING" | "RETRYING" | "TERMINAL" | "CANCELED"; terminalState: string | null; bundleDigest: string; evidenceDigest: string | null; createdAt: number; updatedAt: number; }
export type ReleaseTokenScope = "release:start" | "release:read" | "release:claim";
export interface ReleaseApiTokenRow { id:string; accountId:string; tokenDigest:string; name:string; scopes:ReleaseTokenScope[]; storeId:string|null; createdAt:number; expiresAt:number|null; revokedAt:number|null; }
export interface PluginEvidenceCommit { receiptId:string; storeId:string; accountId:string; nonce:string; digest:string; safePacket:string; expiresAt:number; state:"PENDING"|"COMMITTED"|"ABANDONED"; createdAt:number; }
/** A paid Commerce Readiness Packet that is owed until it is actually delivered.
 *
 * Before this existed a report purchase was a single send attempt: if the
 * buyer had no store or no scan yet, the webhook mailed "reply and we'll
 * send it" and the $9 lived in an inbox. Nothing in the product remembered
 * the debt, so a buyer returning in a later session saw no trace of what
 * they had paid for. An entitlement row is that memory: it is created at
 * purchase, stays unfulfilled until a report is genuinely produced, and
 * keeps the delivered HTML so the buyer can re-read it in the app rather
 * than hunting for an email. */
export interface ReportEntitlementRow {
  id: string; userId: string; purchasedAt: number; expiresAt: number;
  fulfilledAt: number | null; scanId: string | null;
  deliveredTo: string | null; reportHtml: string | null;
}

/** How long an unfulfilled report claim stays claimable.
 *
 * A year, deliberately long. The claim only goes unfulfilled when the
 * buyer has not scanned yet, so a short window would mean taking $9 and
 * then refusing to deliver — a refund request with a good case behind it.
 * The date exists to be shown, as a nudge to run the scan, not to expire
 * quietly. A report that HAS been delivered never expires: it is paid
 * content and stays readable in the app. */
export const REPORT_CLAIM_TTL_MS = 365 * 24 * 60 * 60 * 1000;

// Primary-evidence funnel: the four moments that separate "somebody looked"
// from "somebody paid". Written on the request path that already exists for
// each moment (no client JS, no beacon) so a JS-disabled or blocked visitor
// is still counted. See docs/market — this table is what lets a future
// revenue-evidence judgment cite this product's own funnel instead of only
// competitor pricing pages.
/** A scan that reached a store and could not read it.
 *
 * Two shapes, because one predates the other: the current writer records
 * `state: "UNREADABLE"`, and before that field existed an abstention was
 * stored with the -1 score sentinel. Kept as SQL text so `funnelSummary` and
 * `scanOutcomeSummary` cannot drift apart in how they classify a row. */
const ABSTAINED_PREDICATE =
  // COALESCE, not `=`. A row with no state makes json_extract return NULL, and
  // `NULL = 'UNREADABLE'` is NULL rather than false — so `NOT (kind=... AND
  // <predicate>)` became NULL and SQLite dropped the row from the WHERE clause
  // entirely. An answered scan silently stopped being counted at all.
  "(COALESCE(json_extract(meta_json,'$.state'),'')='UNREADABLE'"
  + " OR (json_extract(meta_json,'$.state') IS NULL"
  + "     AND json_extract(meta_json,'$.score') IS NOT NULL"
  + "     AND CAST(json_extract(meta_json,'$.score') AS INTEGER) < 0))";

/** A row that carries neither a state nor a score. It is not evidence of a
 * successful scan and is never counted as one. */
const UNKNOWN_PREDICATE =
  "(json_extract(meta_json,'$.state') IS NULL"
  + " AND json_extract(meta_json,'$.score') IS NULL)";

export interface ScanOutcomeSummary {
  /** Every recorded scan attempt in the window. */
  attempted: number;
  /** Reached the store, read it, produced a score. */
  answered: number;
  /** Reached the store and could not read it. */
  abstained: number;
  /** Written before the outcome was recorded; unclassifiable. */
  unknown: number;
}

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

// Bumped from 4 when the aggregate-only public MCP usage table was added.
//
// THIS IS NOT OPTIONAL BOOKKEEPING. `ensureSchema` looks its row up BY
// VERSION and compares a checksum of the whole table list. Adding a table
// without moving this number leaves production holding the OLD checksum under
// the SAME version, so every request that touches the database throws
// "app schema version or checksum mismatch" — not one feature, the whole
// service. That is exactly what shipped on 2026-09-01: the site rendered, and
// every login and every scan answered 500.
//
// A new number finds no row, takes the baseline branch, creates only the
// tables that are missing, and leaves earlier production rows untouched. The
// already-deployed `app_public_mcp_usage_v5` owns version 5, so this additive
// AI-usage migration must use the next unused number.
const APP_SCHEMA_VERSION = 14;
const APP_MIGRATION_NAME = "app_aggregate_surface_usage_v14";
const APP_TABLES: [string, string][] = [
  ["users", "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL)"],
  ["sessions", "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)"],
  ["stores", "CREATE TABLE IF NOT EXISTS stores (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, store_url TEXT NOT NULL, woo_key_enc TEXT NOT NULL, woo_secret_enc TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free','pro','agency')), status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"],
  ["scan_results", "CREATE TABLE IF NOT EXISTS scan_results (id TEXT PRIMARY KEY, store_url TEXT NOT NULL, score INTEGER NOT NULL, result_json TEXT NOT NULL, created_at INTEGER NOT NULL)"],
  ["funnel_events", "CREATE TABLE IF NOT EXISTS funnel_events (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('scan_completed','wall_shown','checkout_started','checkout_completed')), store_id TEXT, user_id TEXT, plan TEXT, meta_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL)"],
  ["password_resets", "CREATE TABLE IF NOT EXISTS password_resets (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)"],
  ["billing_events", "CREATE TABLE IF NOT EXISTS billing_events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN ('activated','updated','canceled','past_due','report_purchase')), plan TEXT, amount TEXT, currency TEXT, occurred_at INTEGER NOT NULL, raw_json TEXT NOT NULL DEFAULT '{}')"],
  ["digest_sends", "CREATE TABLE IF NOT EXISTS digest_sends (user_id TEXT PRIMARY KEY, last_sent_at INTEGER NOT NULL)"],
  ["unclaimed_purchases", "CREATE TABLE IF NOT EXISTS unclaimed_purchases (transaction_id TEXT PRIMARY KEY, email TEXT NOT NULL, price_id TEXT, amount TEXT, currency TEXT, occurred_at INTEGER NOT NULL, claimed_at INTEGER, claimed_by TEXT, raw_json TEXT NOT NULL DEFAULT '{}')"],
  ["report_entitlements", "CREATE TABLE IF NOT EXISTS report_entitlements (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, purchased_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, fulfilled_at INTEGER, scan_id TEXT, delivered_to TEXT, report_html TEXT)"],
  ["agentready_public_mcp_usage_daily", "CREATE TABLE IF NOT EXISTS agentready_public_mcp_usage_daily (kst_date TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('success','refused','invalid')), calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0), updated_at INTEGER NOT NULL, PRIMARY KEY(kst_date,tool_name,outcome))"],
  ["agentready_surface_usage_daily", "CREATE TABLE IF NOT EXISTS agentready_surface_usage_daily (kst_date TEXT NOT NULL, surface TEXT NOT NULL CHECK(surface IN ('mcp','rest_preflight','wordpress_evidence','release_gate')), operation TEXT NOT NULL, channel TEXT NOT NULL CHECK(channel IN ('direct','operator','mcp_registry','smithery','glama','mcp_directory','rapidapi','api_market','wordpress_org','github_marketplace','apify')), outcome TEXT NOT NULL CHECK(outcome IN ('answered','abstained','invalid','refused','rate_limited','replay','internal_error')), calls INTEGER NOT NULL DEFAULT 0 CHECK(calls>=0), updated_at INTEGER NOT NULL, PRIMARY KEY(kst_date,surface,operation,channel,outcome))"],
  // Aggregate-only spend guard. It intentionally contains no prompt, reply,
  // merchant, store, or customer identifier.
  ["ai_usage_daily", "CREATE TABLE IF NOT EXISTS ai_usage_daily (day_kst TEXT NOT NULL, model TEXT NOT NULL, reserved_neurons INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, success_count INTEGER NOT NULL DEFAULT 0, unavailable_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day_kst,model))"],
  // Release Gate tables are aggregate/safe by construction. In particular,
  // no upstream response, credential, customer/order/payment data, or raw
  // ownership proof is representable in this schema.
  ["release_gate_protocol_bundles", "CREATE TABLE IF NOT EXISTS release_gate_protocol_bundles (family TEXT NOT NULL, release TEXT NOT NULL, source_sha256 TEXT NOT NULL, vector_sha256 TEXT NOT NULL, manifest_json TEXT NOT NULL, promoted_at INTEGER, PRIMARY KEY(family,release))"],
  ["release_gate_ownership_challenges", "CREATE TABLE IF NOT EXISTS release_gate_ownership_challenges (id TEXT PRIMARY KEY, store_id TEXT NOT NULL, account_id TEXT NOT NULL, challenge_digest TEXT NOT NULL, verified_at INTEGER, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)"],
  ["release_gate_runs", "CREATE TABLE IF NOT EXISTS release_gate_runs (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, store_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode='owned-safe-active'), requested_families_json TEXT NOT NULL, baseline_run_id TEXT, idempotency_key TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','RETRYING','TERMINAL','CANCELED')), terminal_state TEXT, bundle_digest TEXT NOT NULL, evidence_digest TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(account_id,store_id,idempotency_key))"],
  ["release_gate_run_families", "CREATE TABLE IF NOT EXISTS release_gate_run_families (run_id TEXT NOT NULL, family TEXT NOT NULL, state TEXT NOT NULL, reason_code TEXT, PRIMARY KEY(run_id,family))"],
  ["release_gate_check_rollups", "CREATE TABLE IF NOT EXISTS release_gate_check_rollups (run_id TEXT NOT NULL, check_id TEXT NOT NULL, family TEXT NOT NULL, state TEXT NOT NULL, reason_code TEXT, safe_evidence_json TEXT NOT NULL, PRIMARY KEY(run_id,check_id))"],
  ["release_gate_evidence_packets", "CREATE TABLE IF NOT EXISTS release_gate_evidence_packets (run_id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, packet_json TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)"],
  ["release_gate_baselines", "CREATE TABLE IF NOT EXISTS release_gate_baselines (store_id TEXT NOT NULL, bundle_digest TEXT NOT NULL, run_id TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(store_id,bundle_digest))"],
  ["release_gate_deliveries", "CREATE TABLE IF NOT EXISTS release_gate_deliveries (run_id TEXT NOT NULL, channel TEXT NOT NULL, channel_identity TEXT NOT NULL, delivered_at INTEGER NOT NULL, billable INTEGER NOT NULL CHECK(billable IN (0,1)), PRIMARY KEY(run_id,channel,channel_identity))"],
  ["release_gate_billable_claims", "CREATE TABLE IF NOT EXISTS release_gate_billable_claims (run_id TEXT PRIMARY KEY, channel TEXT NOT NULL, channel_identity TEXT NOT NULL, claimed_at INTEGER NOT NULL)"],
  ["release_gate_evidence_nonces", "CREATE TABLE IF NOT EXISTS release_gate_evidence_nonces (store_id TEXT NOT NULL, nonce TEXT NOT NULL, digest TEXT NOT NULL, receipt_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(store_id,nonce))"],
  ["release_gate_evidence_generations", "CREATE TABLE IF NOT EXISTS release_gate_evidence_generations (receipt_id TEXT PRIMARY KEY, store_id TEXT NOT NULL, account_id TEXT NOT NULL, digest TEXT NOT NULL, safe_packet_json TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)"],
  ["release_gate_usage_daily", "CREATE TABLE IF NOT EXISTS release_gate_usage_daily (day_utc TEXT NOT NULL, scope TEXT NOT NULL, subject_digest TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day_utc,scope,subject_digest))"],
  ["release_gate_api_tokens", "CREATE TABLE IF NOT EXISTS release_gate_api_tokens (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, token_digest TEXT NOT NULL UNIQUE, name TEXT NOT NULL, scopes_json TEXT NOT NULL, store_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER)"],
  // This is the authoritative post-v10 ingest state machine. PENDING receipts
  // are inert; only COMMITTED receipts may be pointed to or executed.
  ["release_gate_evidence_commits", "CREATE TABLE IF NOT EXISTS release_gate_evidence_commits (receipt_id TEXT PRIMARY KEY, store_id TEXT NOT NULL, account_id TEXT NOT NULL, nonce TEXT NOT NULL, digest TEXT NOT NULL, safe_packet_json TEXT NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('PENDING','COMMITTED','ABANDONED')), created_at INTEGER NOT NULL, UNIQUE(store_id,nonce))"],
  ["release_gate_active_evidence", "CREATE TABLE IF NOT EXISTS release_gate_active_evidence (store_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, updated_at INTEGER NOT NULL)"],
  // -- v13: the authenticated server-to-server channel -------------------
  //
  // The Apify Actor shares an IP pool with every other Actor, so the public
  // per-IP counter is the wrong instrument for it: the tenth request in a day
  // fails for a caller who has made one. These two tables replace that
  // bottleneck for an authenticated channel, and only for it.
  //
  // The budget is DISTRIBUTED on purpose. An isolate-local Map is not a limit
  // at all on Workers — each isolate keeps its own, so the real ceiling is
  // "however many isolates Cloudflare happens to spin up".
  //
  // `channel_budget_config` is empty until Codex inserts a row, and an absent
  // row means a limit of zero. Fail-closed: turning the channel on is a
  // deliberate configuration act, not a side effect of deploying this code.
  ["channel_budget_config", "CREATE TABLE IF NOT EXISTS channel_budget_config (channel_id TEXT PRIMARY KEY, daily_cap INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)"],
  ["channel_budget_daily", "CREATE TABLE IF NOT EXISTS channel_budget_daily (day_utc TEXT NOT NULL, channel_id TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day_utc,channel_id))"],
  // Idempotency is scoped to one Actor run and one item within it. A replay
  // returns the outcome the first attempt reached and consumes no budget, so
  // a retried run can never produce a second future charge. Only the outcome
  // is stored — never the origin, the token, the body or the result.
  ["channel_idempotency", "CREATE TABLE IF NOT EXISTS channel_idempotency (channel_id TEXT NOT NULL, run_key TEXT NOT NULL, item_key TEXT NOT NULL, outcome TEXT NOT NULL, billable INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY(channel_id,run_key,item_key))"],
  ["release_gate_token_blocks", "CREATE TABLE IF NOT EXISTS release_gate_token_blocks (token_id TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL)"],
  ["release_gate_evidence_order", "CREATE TABLE IF NOT EXISTS release_gate_evidence_order (receipt_id TEXT PRIMARY KEY, generated_at INTEGER NOT NULL)"],
];
const APP_INDEXES: string[] = [
  "CREATE INDEX IF NOT EXISTS funnel_events_kind_idx ON funnel_events(kind, created_at)",
  "CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets(user_id, created_at)",
  "CREATE INDEX IF NOT EXISTS scan_results_store_url_idx ON scan_results(store_url, created_at)",
  "CREATE INDEX IF NOT EXISTS billing_events_user_idx ON billing_events(user_id, occurred_at)",
  "CREATE INDEX IF NOT EXISTS report_entitlements_user_idx ON report_entitlements(user_id, purchased_at)",
  "CREATE INDEX IF NOT EXISTS report_entitlements_owed_idx ON report_entitlements(user_id, fulfilled_at)",
  "CREATE INDEX IF NOT EXISTS unclaimed_purchases_email_idx ON unclaimed_purchases(email, claimed_at)",
  "CREATE INDEX IF NOT EXISTS release_gate_runs_account_idx ON release_gate_runs(account_id, store_id, created_at)",
  "CREATE INDEX IF NOT EXISTS release_gate_challenges_store_idx ON release_gate_ownership_challenges(store_id, expires_at)",
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
    // Release Gate rows are aggregate-only, but they still carry opaque
    // account/store linkage. Remove that linkage with the account rather
    // than leaving an undecryptable shadow graph behind. Global usage
    // counters and financial audit rows keep their separate retention policy.
    await this.db.prepare("DELETE FROM release_gate_deliveries WHERE run_id IN (SELECT id FROM release_gate_runs WHERE account_id=?)").bind(id).run();
    await this.db.prepare("DELETE FROM release_gate_billable_claims WHERE run_id IN (SELECT id FROM release_gate_runs WHERE account_id=?)").bind(id).run();
    await this.db.prepare("DELETE FROM release_gate_run_families WHERE run_id IN (SELECT id FROM release_gate_runs WHERE account_id=?)").bind(id).run();
    await this.db.prepare("DELETE FROM release_gate_check_rollups WHERE run_id IN (SELECT id FROM release_gate_runs WHERE account_id=?)").bind(id).run();
    await this.db.prepare("DELETE FROM release_gate_evidence_packets WHERE run_id IN (SELECT id FROM release_gate_runs WHERE account_id=?)").bind(id).run();
    await this.db.prepare("DELETE FROM release_gate_baselines WHERE store_id IN (SELECT id FROM stores WHERE user_id=?)").bind(id).run();
    await this.db.prepare("DELETE FROM release_gate_active_evidence WHERE store_id IN (SELECT id FROM stores WHERE user_id=?)").bind(id).run();
    await this.db.prepare("DELETE FROM release_gate_evidence_order WHERE receipt_id IN (SELECT receipt_id FROM release_gate_evidence_commits WHERE account_id=?)").bind(id).run();
    await this.db.prepare("DELETE FROM release_gate_evidence_nonces WHERE store_id IN (SELECT id FROM stores WHERE user_id=?)").bind(id).run();
    await this.db.prepare("DELETE FROM release_gate_evidence_generations WHERE account_id=?").bind(id).run();
    await this.db.prepare("DELETE FROM release_gate_evidence_commits WHERE account_id=?").bind(id).run();
    await this.db.prepare("DELETE FROM release_gate_ownership_challenges WHERE account_id=?").bind(id).run();
    await this.db.prepare("DELETE FROM release_gate_token_blocks WHERE token_id IN (SELECT id FROM release_gate_api_tokens WHERE account_id=?)").bind(id).run();
    await this.db.prepare("DELETE FROM release_gate_api_tokens WHERE account_id=?").bind(id).run();
    await this.db.prepare("DELETE FROM release_gate_runs WHERE account_id=?").bind(id).run();
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
  /** Everyone who connected this exact store URL.
   *
   * Scans are anonymous and keyed by URL, so this is how a finished scan
   * finds the buyer who is still owed a report for that store. */
  async usersWithStoreUrl(storeUrl: string): Promise<string[]> {
    await this.ensureSchema();
    const rows = await this.db.prepare(
      "SELECT DISTINCT user_id FROM stores WHERE store_url=?",
    ).bind(storeUrl).all<Row>();
    return rows.results.map(r => String(r.user_id));
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
    amount?: string | null; currency?: string | null;
  }): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.db.prepare(
      "INSERT INTO billing_events(id,user_id,event_type,plan,amount,currency,occurred_at,raw_json) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(
      crypto.randomUUID(), e.userId, e.eventType, e.plan ?? null, e.amount ?? null, e.currency ?? null,
      Date.now(), "{}",
    ).run();
    return r.success;
  }
/** Money that arrived under an address with no account here.
   *
   * Paddle's checkout lets a buyer edit their email before paying, so a
   * payment can land on an address this app has never seen. The webhook used
   * to answer HTTP 200 with `{ ignored: "unknown user" }` — Paddle reads that
   * as delivered and stops retrying, so the charge went through and nothing
   * anywhere recorded it. The buyer had paid and there was nothing to show
   * them, which is a refund request with a very good case behind it.
   *
   * Held here instead, keyed by Paddle's transaction id so a retry cannot
   * double-record, until someone signs in with that address. */
  async recordUnclaimedPurchase(p: {
    transactionId: string; email: string; priceId: string | null;
    amount: string | null; currency: string | null;
  }): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.db.prepare(
      "INSERT OR IGNORE INTO unclaimed_purchases(transaction_id,email,price_id,amount,currency,occurred_at,raw_json) " +
      "VALUES(?,?,?,?,?,?,?)",
    ).bind(
      p.transactionId, p.email.toLowerCase(), p.priceId, p.amount, p.currency,
      Date.now(), "{}",
    ).run();
    return (r.meta?.changes ?? 0) > 0;
  }

  async unclaimedPurchasesFor(email: string): Promise<{
    transactionId: string; priceId: string | null; amount: string | null;
    currency: string | null; occurredAt: number;
  }[]> {
    await this.ensureSchema();
    const rows = await this.db.prepare(
      "SELECT * FROM unclaimed_purchases WHERE email=? AND claimed_at IS NULL ORDER BY occurred_at ASC",
    ).bind(email.toLowerCase()).all<Row>();
    return rows.results.map(r => ({
      transactionId: String(r.transaction_id),
      priceId: r.price_id == null ? null : String(r.price_id),
      amount: r.amount == null ? null : String(r.amount),
      currency: r.currency == null ? null : String(r.currency),
      occurredAt: Number(r.occurred_at),
    }));
  }

  async markPurchaseClaimed(transactionId: string, userId: string): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.db.prepare(
      "UPDATE unclaimed_purchases SET claimed_at=?, claimed_by=? WHERE transaction_id=? AND claimed_at IS NULL",
    ).bind(Date.now(), userId, transactionId).run();
    return (r.meta?.changes ?? 0) > 0;
  }

    private reportEntitlement(r: Row): ReportEntitlementRow {
    return {
      id: String(r.id), userId: String(r.user_id), purchasedAt: Number(r.purchased_at),
      expiresAt: Number(r.expires_at),
      fulfilledAt: r.fulfilled_at == null ? null : Number(r.fulfilled_at),
      scanId: r.scan_id == null ? null : String(r.scan_id),
      deliveredTo: r.delivered_to == null ? null : String(r.delivered_to),
      reportHtml: r.report_html == null ? null : String(r.report_html),
    };
  }

  /** Record that a Commerce Readiness Packet is owed. Called the moment the purchase
   * webhook lands, before any attempt to produce the report — so a delivery
   * that fails leaves a debt the product can settle later, not silence. */
  async createReportEntitlement(userId: string): Promise<string> {
    await this.ensureSchema();
    const id = crypto.randomUUID();
    const now = Date.now();
    await this.db.prepare(
      "INSERT INTO report_entitlements(id,user_id,purchased_at,expires_at) VALUES(?,?,?,?)",
    ).bind(id, userId, now, now + REPORT_CLAIM_TTL_MS).run();
    return id;
  }

  /** The oldest report this user has paid for and not received, if any. */
  async oldestUnfulfilledReport(userId: string): Promise<ReportEntitlementRow | null> {
    await this.ensureSchema();
    const r = await this.db.prepare(
      "SELECT * FROM report_entitlements WHERE user_id=? AND fulfilled_at IS NULL AND expires_at > ? " +
      "ORDER BY purchased_at ASC LIMIT 1",
    ).bind(userId, Date.now()).first<Row>();
    return r ? this.reportEntitlement(r) : null;
  }

  /** Settle the debt, keeping the delivered report so it can be re-read. */
  async fulfilReportEntitlement(
    id: string, scanId: string, deliveredTo: string, reportHtml: string,
  ): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.db.prepare(
      "UPDATE report_entitlements SET fulfilled_at=?, scan_id=?, delivered_to=?, report_html=? " +
      "WHERE id=? AND fulfilled_at IS NULL",
    ).bind(Date.now(), scanId, deliveredTo, reportHtml, id).run();
    return (r.meta?.changes ?? 0) > 0;
  }

  async listReportEntitlements(userId: string, limit = 20): Promise<ReportEntitlementRow[]> {
    await this.ensureSchema();
    const rows = await this.db.prepare(
      "SELECT * FROM report_entitlements WHERE user_id=? ORDER BY purchased_at DESC LIMIT ?",
    ).bind(userId, limit).all<Row>();
    return rows.results.map(r => this.reportEntitlement(r));
  }

  async getReportEntitlement(id: string, userId: string): Promise<ReportEntitlementRow | null> {
    await this.ensureSchema();
    const r = await this.db.prepare(
      "SELECT * FROM report_entitlements WHERE id=? AND user_id=?",
    ).bind(id, userId).first<Row>();
    return r ? this.reportEntitlement(r) : null;
  }

  /** Atomically reserve a bounded Workers AI allowance for one KST day.
   * D1 performs the conflict check and increment in one statement, so two
   * concurrent Workers cannot both spend the last remaining allowance. */
  async reserveAiBudget(dayKst: string, model: string, neurons: number, dailyCap: number): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.db.prepare(
      "INSERT INTO ai_usage_daily(day_kst,model,reserved_neurons,attempts,success_count,unavailable_count) " +
      "SELECT ?,?,?,1,0,0 WHERE ? <= ? " +
      "ON CONFLICT(day_kst,model) DO UPDATE SET reserved_neurons=ai_usage_daily.reserved_neurons+excluded.reserved_neurons, attempts=ai_usage_daily.attempts+1 " +
      "WHERE ai_usage_daily.reserved_neurons+excluded.reserved_neurons <= ?",
    ).bind(dayKst, model, neurons, neurons, dailyCap, dailyCap).run();
    return r.success && (r.meta?.changes ?? 0) === 1;
  }

  async markAiOutcome(dayKst: string, model: string, outcome: "success" | "unavailable"): Promise<void> {
    await this.ensureSchema();
    const column = outcome === "success" ? "success_count" : "unavailable_count";
    await this.db.prepare(
      `UPDATE ai_usage_daily SET ${column}=${column}+1 WHERE day_kst=? AND model=?`,
    ).bind(dayKst, model).run();
  }

  async getAiUsage(dayKst: string, model: string): Promise<{ reservedNeurons: number; attempts: number; successCount: number; unavailableCount: number } | null> {
    await this.ensureSchema();
    const row = await this.db.prepare(
      "SELECT reserved_neurons,attempts,success_count,unavailable_count FROM ai_usage_daily WHERE day_kst=? AND model=?",
    ).bind(dayKst, model).first<Row>();
    return row ? {
      reservedNeurons: Number(row.reserved_neurons), attempts: Number(row.attempts),
      successCount: Number(row.success_count), unavailableCount: Number(row.unavailable_count),
    } : null;
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
  /** Funnel stages, in order.
   *
   * `scan_completed` counts only scans that **answered**. A scan that reached a
   * store and could not read it writes the same `kind` — the column has a
   * CHECK constraint only a table rebuild could widen — so the abstention is
   * carried in `meta.state` and excluded here. Before this, a shop that was
   * down counted as a completed scan, and every conversion rate computed from
   * this number was inflated by traffic that never got an answer.
   *
   * A row carrying neither a state nor a score is excluded too. It is not
   * evidence that a scan answered, and counting it here would be deciding an
   * unclassifiable row in the flattering direction.
   *
   * Use `scanOutcomeSummary` for the whole picture; this stays the four-stage
   * funnel other callers already read. */
  async funnelSummary(sinceMs: number): Promise<{ kind: FunnelEventKind; count: number }[]> {
    await this.ensureSchema();
    const rows = await this.db.prepare(
      `SELECT kind, COUNT(*) AS n FROM funnel_events
       WHERE created_at>=? AND NOT (kind='scan_completed'
             AND (${ABSTAINED_PREDICATE} OR ${UNKNOWN_PREDICATE}))
       GROUP BY kind`,
    ).bind(sinceMs).all<{ kind: FunnelEventKind; n: number }>();
    const counts = new Map(rows.results.map(r => [r.kind, Number(r.n)]));
    const order: FunnelEventKind[] = ["scan_completed", "wall_shown", "checkout_started", "checkout_completed"];
    return order.map(kind => ({ kind, count: counts.get(kind) ?? 0 }));
  }

  /** Scan outcomes, derived rather than stored.
   *
   * `funnel_events.kind` has a CHECK constraint listing four values, and
   * widening it means rebuilding a production table. The outcome is therefore
   * read out of `meta_json` at query time, in SQL, so no raw row reaches the
   * Worker: an operations endpoint must never pull store URLs into memory to
   * count them.
   *
   * The classification is deliberately conservative about history. A row
   * written before `state` existed is judged by its score; a row with neither
   * is `unknown`, never silently a success. `attempted` is the row count, so
   * `answered + abstained + unknown === attempted` holds by construction. */
  async scanOutcomeSummary(sinceMs: number): Promise<ScanOutcomeSummary> {
    await this.ensureSchema();
    const row = await this.db.prepare(
      `SELECT COUNT(*) AS attempted,
              SUM(CASE WHEN ${ABSTAINED_PREDICATE} THEN 1 ELSE 0 END) AS abstained,
              SUM(CASE WHEN ${UNKNOWN_PREDICATE} THEN 1 ELSE 0 END) AS unknown_count
       FROM funnel_events WHERE created_at>=? AND kind='scan_completed'`,
    ).bind(sinceMs).first<{ attempted: number; abstained: number | null; unknown_count: number | null }>();
    const attempted = Number(row?.attempted ?? 0);
    const abstained = Number(row?.abstained ?? 0);
    const unknown = Number(row?.unknown_count ?? 0);
    return { attempted, answered: attempted - abstained - unknown, abstained, unknown };
  }

  /** Privacy-safe public MCP telemetry: daily aggregate only. No URL,
   * request payload, client identity, IP address, or result is retained. */
  async recordPublicMcpCall(toolName: string, outcome: "success" | "refused" | "invalid", now = Date.now()): Promise<void> {
    await this.ensureSchema();
    const kstDate = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const row = await this.db.prepare(
      "INSERT INTO agentready_public_mcp_usage_daily(kst_date,tool_name,outcome,calls,updated_at) VALUES(?,?,?,1,?) "
      + "ON CONFLICT(kst_date,tool_name,outcome) DO UPDATE SET calls=calls+1,updated_at=excluded.updated_at",
    ).bind(kstDate, toolName, outcome, now).run();
    if (!row.success) throw new Error("public MCP usage write failed");
  }

  /** Canonical product telemetry. Every dimension is a finite aggregate label;
   * a URL, IP, account, token, payload or result cannot be represented. */
  async recordSurfaceUsage(surface: UsageSurface, operation: string, channel: UsageChannel,
                           outcome: UsageOutcome, now = Date.now()): Promise<void> {
    if (!(USAGE_SURFACES as readonly string[]).includes(surface)
        || !(USAGE_CHANNELS as readonly string[]).includes(channel)
        || !(USAGE_OUTCOMES as readonly string[]).includes(outcome)
        || !/^[a-z][a-z0-9_]{1,79}$/.test(operation)) {
      throw new Error("invalid aggregate usage label");
    }
    await this.ensureSchema();
    const kstDate = new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const row = await this.db.prepare(
      "INSERT INTO agentready_surface_usage_daily(kst_date,surface,operation,channel,outcome,calls,updated_at) VALUES(?,?,?,?,?,1,?) "
      + "ON CONFLICT(kst_date,surface,operation,channel,outcome) DO UPDATE SET calls=calls+1,updated_at=excluded.updated_at",
    ).bind(kstDate, surface, operation, channel, outcome, now).run();
    if (!row.success) throw new Error("surface usage write failed");
  }

  async surfaceUsageSummary(sinceKstDate: string): Promise<{
    kst_date: string; surface: string; operation: string; channel: string; outcome: string; calls: number;
  }[]> {
    await this.ensureSchema();
    const rows = await this.db.prepare(
      "SELECT kst_date,surface,operation,channel,outcome,calls FROM agentready_surface_usage_daily "
      + "WHERE kst_date>=? ORDER BY kst_date,surface,operation,channel,outcome",
    ).bind(sinceKstDate).all<{ kst_date: string; surface: string; operation: string; channel: string; outcome: string; calls: number }>();
    return rows.results.map(row => ({ ...row, calls: Number(row.calls) }));
  }

  async createReleaseChallenge(id: string, storeId: string, accountId: string, challengeDigest: string, expiresAt: number): Promise<boolean> {
    await this.ensureSchema();
    const r = await this.db.prepare("INSERT INTO release_gate_ownership_challenges(id,store_id,account_id,challenge_digest,expires_at,created_at) VALUES(?,?,?,?,?,?)")
      .bind(id, storeId, accountId, challengeDigest, expiresAt, Date.now()).run(); return r.success && (r.meta?.changes ?? 0) === 1;
  }
  async verifyReleaseChallenge(id: string, storeId: string, accountId: string, challengeDigest: string): Promise<boolean> {
    await this.ensureSchema(); const r = await this.db.prepare("UPDATE release_gate_ownership_challenges SET verified_at=? WHERE id=? AND store_id=? AND account_id=? AND challenge_digest=? AND verified_at IS NULL AND expires_at>?")
      .bind(Date.now(), id, storeId, accountId, challengeDigest, Date.now()).run(); return r.success && (r.meta?.changes ?? 0) === 1;
  }
  async hasVerifiedReleaseOwnership(storeId: string, accountId: string): Promise<boolean> { await this.ensureSchema(); return Boolean(await this.db.prepare("SELECT id FROM release_gate_ownership_challenges WHERE store_id=? AND account_id=? AND verified_at IS NOT NULL AND expires_at>? ORDER BY verified_at DESC LIMIT 1").bind(storeId, accountId, Date.now()).first()); }
  async createOrGetReleaseRun(row: Omit<ReleaseGateRunRow, "createdAt" | "updatedAt" | "terminalState" | "evidenceDigest">): Promise<ReleaseGateRunRow> {
    await this.ensureSchema(); const now = Date.now(); await this.db.prepare("INSERT OR IGNORE INTO release_gate_runs(id,account_id,store_id,mode,requested_families_json,baseline_run_id,idempotency_key,state,terminal_state,bundle_digest,evidence_digest,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,NULL,?,NULL,?,?)")
      .bind(row.id,row.accountId,row.storeId,row.mode,row.requestedFamiliesJson,row.baselineRunId,row.idempotencyKey,row.state,row.bundleDigest,now,now).run();
    const saved = await this.db.prepare("SELECT * FROM release_gate_runs WHERE account_id=? AND store_id=? AND idempotency_key=?").bind(row.accountId,row.storeId,row.idempotencyKey).first<Row>(); if (!saved) throw new Error("release run persistence failed"); return this.releaseGateRun(saved);
  }
  async getReleaseRun(id: string, accountId: string): Promise<ReleaseGateRunRow | null> { await this.ensureSchema(); const row = await this.db.prepare("SELECT * FROM release_gate_runs WHERE id=? AND account_id=?").bind(id,accountId).first<Row>(); return row ? this.releaseGateRun(row) : null; }
  /** Worker-only lookup. This is deliberately not exposed by HTTP; the workflow
   * receives an opaque run id from the authenticated create route. */
  async getReleaseRunForWorkflow(id: string): Promise<ReleaseGateRunRow | null> { await this.ensureSchema(); const row = await this.db.prepare("SELECT * FROM release_gate_runs WHERE id=?").bind(id).first<Row>(); return row ? this.releaseGateRun(row) : null; }
  async markReleaseDispatchFailed(id: string, accountId: string): Promise<boolean> { await this.ensureSchema(); const r=await this.db.prepare("UPDATE release_gate_runs SET state='TERMINAL',terminal_state='INFRA_ERROR',updated_at=? WHERE id=? AND account_id=? AND state='QUEUED'").bind(Date.now(),id,accountId).run(); return r.success&&(r.meta?.changes??0)===1; }
  async claimReleaseRunForWorkflow(id: string): Promise<boolean> { await this.ensureSchema(); const r=await this.db.prepare("UPDATE release_gate_runs SET state='RUNNING',updated_at=? WHERE id=? AND state IN ('QUEUED','RETRYING')").bind(Date.now(),id).run(); return r.success&&(r.meta?.changes??0)===1; }
  /** Publish the generation before consuming its nonce. A failed generation
   * write can therefore never burn a plugin retry token or replace a prior
   * receipt. The compensating delete only touches this fresh opaque receipt. */
  async recordPluginEvidence(receiptId:string,storeId:string,accountId:string,nonce:string,digest:string,safePacket:string,expiresAt:number,generatedAt:number):Promise<"stored"|"replay"|"conflict"|"failed">{await this.ensureSchema();const now=Date.now();const pending=await this.db.prepare("INSERT OR IGNORE INTO release_gate_evidence_commits(receipt_id,store_id,account_id,nonce,digest,safe_packet_json,expires_at,state,created_at) VALUES(?,?,?,?,?,?,?,'PENDING',?)").bind(receiptId,storeId,accountId,nonce,digest,safePacket,expiresAt,now).run();let commit:PluginEvidenceCommit|null=null;if(!pending.success)return"failed";if((pending.meta?.changes??0)===0){commit=await this.getPluginEvidenceCommit(storeId,nonce);if(!commit)return"failed";if(commit.digest!==digest||commit.accountId!==accountId)return"conflict";if(commit.state==="COMMITTED")return"replay";}else commit={receiptId,storeId,accountId,nonce,digest,safePacket,expiresAt,state:"PENDING",createdAt:now};if(commit.state==="ABANDONED")return"conflict";/* A crash after the PENDING insert must be recoverable: restore the immutable
     generation order before this receipt can become executable or active. */const order=await this.db.prepare("INSERT OR IGNORE INTO release_gate_evidence_order(receipt_id,generated_at) VALUES(?,?)").bind(commit.receiptId,generatedAt).run();if(!order.success)return"failed";const finalized=await this.db.prepare("UPDATE release_gate_evidence_commits SET state='COMMITTED' WHERE receipt_id=? AND state='PENDING'").bind(commit.receiptId).run();if(!finalized.success)return"failed";const pointer=await this.db.prepare("INSERT INTO release_gate_active_evidence(store_id,receipt_id,updated_at) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM release_gate_active_evidence p JOIN release_gate_evidence_order o ON o.receipt_id=p.receipt_id WHERE p.store_id=? AND o.generated_at>=?) ON CONFLICT(store_id) DO UPDATE SET receipt_id=excluded.receipt_id,updated_at=excluded.updated_at").bind(storeId,commit.receiptId,now,storeId,generatedAt).run();if(!pointer.success)return"failed";return pending.meta?.changes===1?"stored":"replay";}
  async getActivePluginEvidence(storeId:string,accountId:string,now=Date.now()):Promise<PluginEvidenceCommit|null>{await this.ensureSchema();let row=await this.db.prepare("SELECT c.* FROM release_gate_active_evidence p JOIN release_gate_evidence_commits c ON c.receipt_id=p.receipt_id WHERE p.store_id=? AND c.account_id=? AND c.state='COMMITTED' AND c.expires_at>?").bind(storeId,accountId,now).first<Row>();if(!row){row=await this.db.prepare("SELECT c.* FROM release_gate_evidence_commits c LEFT JOIN release_gate_evidence_order o ON o.receipt_id=c.receipt_id WHERE c.store_id=? AND c.account_id=? AND c.state='COMMITTED' AND c.expires_at>? ORDER BY COALESCE(o.generated_at,c.created_at) DESC,c.created_at DESC LIMIT 1").bind(storeId,accountId,now).first<Row>();if(row){const repair=await this.db.prepare("INSERT INTO release_gate_active_evidence(store_id,receipt_id,updated_at) VALUES(?,?,?) ON CONFLICT(store_id) DO UPDATE SET receipt_id=excluded.receipt_id,updated_at=excluded.updated_at").bind(storeId,String(row.receipt_id),now).run();if(!repair.success)return null;}}return row?this.pluginEvidenceCommit(row):null;}
  private async getPluginEvidenceCommit(storeId:string,nonce:string):Promise<PluginEvidenceCommit|null>{const row=await this.db.prepare("SELECT * FROM release_gate_evidence_commits WHERE store_id=? AND nonce=?").bind(storeId,nonce).first<Row>();return row?this.pluginEvidenceCommit(row):null;}
  async listReleaseRuns(accountId: string, limit = 25): Promise<ReleaseGateRunRow[]> { await this.ensureSchema(); const rows = await this.db.prepare("SELECT * FROM release_gate_runs WHERE account_id=? ORDER BY created_at DESC LIMIT ?").bind(accountId,Math.max(1,Math.min(limit,100))).all<Row>(); return rows.results.map(row => this.releaseGateRun(row)); }
  async publishReleaseResult(runId: string, accountId: string, terminalState: string, evidenceDigest: string, packetJson: string): Promise<boolean> {
    await this.ensureSchema(); const now = Date.now(); const expires = now + 90 * 86_400_000;
    const evidence = await this.db.prepare("INSERT OR IGNORE INTO release_gate_evidence_packets(run_id,digest,packet_json,expires_at,created_at) VALUES(?,?,?,?,?)").bind(runId,evidenceDigest,packetJson,expires,now).run(); if (!evidence.success) return false;
    const run = await this.db.prepare("UPDATE release_gate_runs SET state='TERMINAL',terminal_state=?,evidence_digest=?,updated_at=? WHERE id=? AND account_id=? AND state IN ('QUEUED','RUNNING','RETRYING')").bind(terminalState,evidenceDigest,now,runId,accountId).run(); return (run.meta?.changes ?? 0) === 1 || (await this.getReleaseRun(runId,accountId))?.evidenceDigest === evidenceDigest;
  }
  async getReleaseEvidence(runId: string): Promise<string | null> { await this.ensureSchema(); const row = await this.db.prepare("SELECT packet_json FROM release_gate_evidence_packets WHERE run_id=? AND expires_at>?").bind(runId,Date.now()).first<{packet_json:string}>(); return row?.packet_json ?? null; }
  async recordReleaseDelivery(runId: string, channel: string, channelIdentity: string, billable: boolean): Promise<boolean> { await this.ensureSchema(); const r = await this.db.prepare("INSERT OR IGNORE INTO release_gate_deliveries(run_id,channel,channel_identity,delivered_at,billable) VALUES(?,?,?,?,?)").bind(runId,channel,channelIdentity,Date.now(),billable ? 1 : 0).run(); return r.success && (r.meta?.changes ?? 0) === 1; }
  /** The unique run_id insert is the authoritative exactly-once eligibility
   * gate. Delivery records may be replayed across channels, eligibility may not. */
  async claimReleaseDelivery(runId: string, channel: string, channelIdentity: string, eligible: boolean): Promise<{ firstDelivery: boolean; eligible: boolean }> { await this.ensureSchema(); const now=Date.now(); const delivery=await this.db.prepare("INSERT OR IGNORE INTO release_gate_deliveries(run_id,channel,channel_identity,delivered_at,billable) VALUES(?,?,?,?,0)").bind(runId,channel,channelIdentity,now).run(); const firstDelivery=delivery.success&&(delivery.meta?.changes??0)===1; if(!firstDelivery||!eligible)return{firstDelivery,eligible:false}; const billable=await this.db.prepare("INSERT OR IGNORE INTO release_gate_billable_claims(run_id,channel,channel_identity,claimed_at) VALUES(?,?,?,?)").bind(runId,channel,channelIdentity,now).run(); return{firstDelivery,eligible:billable.success&&(billable.meta?.changes??0)===1}; }
  async setReleaseBaseline(storeId: string, bundleDigest: string, runId: string): Promise<void> { await this.ensureSchema(); await this.db.prepare("INSERT INTO release_gate_baselines(store_id,bundle_digest,run_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(store_id,bundle_digest) DO UPDATE SET run_id=excluded.run_id,updated_at=excluded.updated_at").bind(storeId,bundleDigest,runId,Date.now()).run(); }
  async incrementReleaseUsage(dayUtc: string, scope: string, subjectDigest: string, cap: number): Promise<boolean> { await this.ensureSchema(); const r = await this.db.prepare("INSERT INTO release_gate_usage_daily(day_utc,scope,subject_digest,count) SELECT ?,?,?,1 WHERE 1<=? ON CONFLICT(day_utc,scope,subject_digest) DO UPDATE SET count=count+1 WHERE count< ?").bind(dayUtc,scope,subjectDigest,cap,cap).run(); return r.success && (r.meta?.changes ?? 0) === 1; }
  // -- v13 channel budget and idempotency --------------------------------

  /** The configured daily cap for a channel. Absent means zero, and zero means
   * the channel is off. Codex configures it; deploying this code does not. */
  async channelDailyCap(channelId: string): Promise<number> {
    await this.ensureSchema();
    const row = await this.db.prepare("SELECT daily_cap FROM channel_budget_config WHERE channel_id=?")
      .bind(channelId).first<{ daily_cap: number }>();
    return row ? Math.max(0, Number(row.daily_cap)) : 0;
  }

  /** Take one unit of today's channel budget, atomically, across every isolate.
   *
   * The conditional UPDATE is the whole point: two isolates racing on the last
   * unit both attempt the write and exactly one reports a change. */
  async consumeChannelBudget(dayUtc: string, channelId: string): Promise<boolean> {
    const cap = await this.channelDailyCap(channelId);
    if (cap <= 0) return false;
    const r = await this.db.prepare(
      "INSERT INTO channel_budget_daily(day_utc,channel_id,count) SELECT ?,?,1 WHERE 1<=? "
      + "ON CONFLICT(day_utc,channel_id) DO UPDATE SET count=count+1 WHERE count< ?")
      .bind(dayUtc, channelId, cap, cap).run();
    return r.success && (r.meta?.changes ?? 0) === 1;
  }

  /** Set the cap. Used by an operations route and by tests; never by a request. */
  async setChannelDailyCap(channelId: string, cap: number): Promise<void> {
    await this.ensureSchema();
    await this.db.prepare(
      "INSERT INTO channel_budget_config(channel_id,daily_cap,updated_at) VALUES(?,?,?) "
      + "ON CONFLICT(channel_id) DO UPDATE SET daily_cap=excluded.daily_cap, updated_at=excluded.updated_at")
      .bind(channelId, Math.max(0, Math.trunc(cap)), Date.now()).run();
  }

  async channelBudgetUsed(dayUtc: string, channelId: string): Promise<number> {
    await this.ensureSchema();
    const row = await this.db.prepare("SELECT count FROM channel_budget_daily WHERE day_utc=? AND channel_id=?")
      .bind(dayUtc, channelId).first<{ count: number }>();
    return row ? Number(row.count) : 0;
  }

  /** The outcome a previous attempt at this exact (run, item) reached. */
  async recallChannelOutcome(channelId: string, runKey: string, itemKey: string):
      Promise<{ outcome: string; billable: boolean } | null> {
    await this.ensureSchema();
    const row = await this.db.prepare(
      "SELECT outcome,billable FROM channel_idempotency WHERE channel_id=? AND run_key=? AND item_key=?")
      .bind(channelId, runKey, itemKey).first<{ outcome: string; billable: number }>();
    return row ? { outcome: String(row.outcome), billable: Number(row.billable) === 1 } : null;
  }

  /** Record an outcome once. A second write for the same key is ignored, so a
   * replay can never overwrite the first answer with a different one. */
  async rememberChannelOutcome(channelId: string, runKey: string, itemKey: string,
                               outcome: string, billable: boolean): Promise<void> {
    await this.ensureSchema();
    await this.db.prepare(
      "INSERT OR IGNORE INTO channel_idempotency(channel_id,run_key,item_key,outcome,billable,created_at) "
      + "VALUES(?,?,?,?,?,?)")
      .bind(channelId, runKey, itemKey, outcome, billable ? 1 : 0, Date.now()).run();
  }

  async createReleaseApiToken(row:ReleaseApiTokenRow):Promise<boolean>{await this.ensureSchema();const r=await this.db.prepare("INSERT INTO release_gate_api_tokens(id,account_id,token_digest,name,scopes_json,store_id,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?,?,?,NULL)").bind(row.id,row.accountId,row.tokenDigest,row.name,JSON.stringify(row.scopes),row.storeId,row.createdAt,row.expiresAt).run();return r.success&&(r.meta?.changes??0)===1;}
  async listReleaseApiTokens(accountId:string):Promise<ReleaseApiTokenRow[]>{await this.ensureSchema();const rows=await this.db.prepare("SELECT * FROM release_gate_api_tokens WHERE account_id=? ORDER BY created_at DESC").bind(accountId).all<Row>();return rows.results.map(r=>this.releaseApiToken(r));}
  async getReleaseApiToken(tokenDigest:string):Promise<ReleaseApiTokenRow|null>{await this.ensureSchema();const row=await this.db.prepare("SELECT t.* FROM release_gate_api_tokens t LEFT JOIN release_gate_token_blocks b ON b.token_id=t.id WHERE t.token_digest=? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>?) AND b.token_id IS NULL").bind(tokenDigest,Date.now()).first<Row>();return row?this.releaseApiToken(row):null;}
  async blockReleaseApiToken(id:string,reason:string):Promise<boolean>{await this.ensureSchema();const r=await this.db.prepare("INSERT OR IGNORE INTO release_gate_token_blocks(token_id,reason,created_at) VALUES(?,?,?)").bind(id,reason,Date.now()).run();return r.success&&(r.meta?.changes??0)===1;}
  async unblockReleaseApiToken(id:string):Promise<boolean>{await this.ensureSchema();const r=await this.db.prepare("DELETE FROM release_gate_token_blocks WHERE token_id=?").bind(id).run();return r.success;}
  async revokeReleaseApiToken(id:string,accountId:string):Promise<boolean>{await this.ensureSchema();const r=await this.db.prepare("UPDATE release_gate_api_tokens SET revoked_at=? WHERE id=? AND account_id=? AND revoked_at IS NULL").bind(Date.now(),id,accountId).run();return r.success&&(r.meta?.changes??0)===1;}

  private store(r: Row): StoreRow {
    return {
      id: String(r.id), userId: String(r.user_id), name: String(r.name), storeUrl: String(r.store_url),
      wooKeyEnc: String(r.woo_key_enc), wooSecretEnc: String(r.woo_secret_enc),
      plan: String(r.plan) as PlanKey, status: String(r.status),
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    };
  }
  private releaseGateRun(r: Row): ReleaseGateRunRow { return { id: String(r.id), accountId: String(r.account_id), storeId: String(r.store_id), mode: "owned-safe-active", requestedFamiliesJson: String(r.requested_families_json), baselineRunId: r.baseline_run_id == null ? null : String(r.baseline_run_id), idempotencyKey: String(r.idempotency_key), state: String(r.state) as ReleaseGateRunRow["state"], terminalState: r.terminal_state == null ? null : String(r.terminal_state), bundleDigest: String(r.bundle_digest), evidenceDigest: r.evidence_digest == null ? null : String(r.evidence_digest), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) }; }
  private releaseApiToken(r:Row):ReleaseApiTokenRow{let scopes:ReleaseTokenScope[]=[];try{const value=JSON.parse(String(r.scopes_json));if(Array.isArray(value)&&value.every(x=>x==="release:start"||x==="release:read"||x==="release:claim"))scopes=value as ReleaseTokenScope[];}catch{}return{id:String(r.id),accountId:String(r.account_id),tokenDigest:String(r.token_digest),name:String(r.name),scopes,storeId:r.store_id==null?null:String(r.store_id),createdAt:Number(r.created_at),expiresAt:r.expires_at==null?null:Number(r.expires_at),revokedAt:r.revoked_at==null?null:Number(r.revoked_at)};}
  private pluginEvidenceCommit(r:Row):PluginEvidenceCommit{return{receiptId:String(r.receipt_id),storeId:String(r.store_id),accountId:String(r.account_id),nonce:String(r.nonce),digest:String(r.digest),safePacket:String(r.safe_packet_json),expiresAt:Number(r.expires_at),state:String(r.state) as PluginEvidenceCommit["state"],createdAt:Number(r.created_at)};}
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

export const PLAN_OFFER_LIMITS: Record<PlanKey, number> = { free: 25, pro: -1, agency: -1 };
export const PLAN_STORE_LIMITS: Record<PlanKey, number> = { free: 1, pro: 1, agency: 25 };
export function offerLimitFor(plan: PlanKey): number { return PLAN_OFFER_LIMITS[plan] ?? 25; }
export function storeLimitFor(plan: PlanKey): number { return PLAN_STORE_LIMITS[plan] ?? 1; }
