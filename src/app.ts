// Merchant app routes: accounts, stores, scan, dashboard, billing, Paddle
// webhooks, and the per-store agent surface (/feed/{id}, /mcp/{id}).
// Returns null for unhandled paths so index.ts can fall through to the
// legacy env-configured endpoints.
import { AppStore, offerLimitFor, type PlanKey, type StoreRow } from "./core/appStore.ts";
import { isPublishableClientToken } from "./core/paddleToken.ts";
import {
  hashPassword, verifyPassword, isValidEmail, newSessionToken, hashToken,
  sessionCookie, clearedSessionCookie, readSessionCookie, SESSION_TTL_MS,
} from "./core/auth.ts";
import { encryptSecret, decryptSecret, encryptionSecret, normalizeStoreUrl, applyOfferLimit, storeServiceConfig } from "./core/tenants.ts";
import { scanStore, type ScanResult } from "./core/scan.ts";
import {
  signupPage, loginPage, dashboardPage, storeCard, storeFormPage,
  billingPage, scanFormPage, scanResultPage, readForm, escapeHtml,
  forgotPasswordPage, resetPasswordPage, resetLinkExpiredPage, accountPage,
  adminUsersPage, adminUserDetailPage, proUpgradeCard, releaseGateSetupPage, type CheckoutConfig,
} from "./web.ts";
import { claimPurchases, handlePaddleWebhook, settleOwedReport, type PaddleEnv } from "./webhooks.ts";
import { TOOL_NAME, TOOL_DESCRIPTION, TOOL_INPUT_SCHEMA } from "./mcp.ts";
import { handleJsonRpc, isJsonRpc, type McpTool } from "./core/mcpRpc.ts";
import { AGENTREADY_SERVER_NAME, AGENTREADY_VERSION } from "./productIdentity.ts";
import {
  createCheckoutSession, getCheckoutSession, updateCheckoutSession,
  ACP_API_VERSION, discoveryDocument, type AcpMeta, type QuoteContext,
} from "./core/acpQuote.ts";
import { sendEmail, passwordResetEmailHtml } from "./core/email.ts";
import type { WorkersAiBinding } from "./core/aiJudge.ts";
import type { RevenueGuard } from "./core/guard.ts";
import type { ServiceConfig } from "./service.ts";
import { ContractError, parseAcceptanceRunInput, parsePreflightInput } from "./releaseGate/schemas.ts";
import { runPreflight } from "./releaseGate/preflight.ts";
import { deriveOwnershipKey, ReleaseGateStore } from "./releaseGate/store.ts";
import { canonicalPluginEvidence, validatePluginEvidence } from "./releaseGate/pluginEvidence.ts";
import { evidenceCoversFamilies } from "./releaseGate/signedEvidence.ts";
import { createReleaseToken, parseTokenCreate, publicToken, rotateReleaseToken } from "./releaseGate/apiTokens.ts";

export interface AppEnv {
  FINANCIAL_DB?: unknown;
  APP_ENCRYPTION_SECRET?: string;
  CART_SIGNING_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  PADDLE_WEBHOOK_SECRET?: string;
  PADDLE_PRICE_REPORT?: string;
  PADDLE_PRICE_PRO?: string;
  PADDLE_PRICE_AGENCY?: string;
  // Real (Paddle.js) checkout renders only when this is set — see
  // checkoutConfig() below. Missing it, every paid CTA falls back to a
  // disabled "Coming soon" button instead of a broken/absent one.
  PADDLE_CLIENT_TOKEN?: string;
  OPS_TOKEN?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  ADMIN_PASSWORD?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  AI?: WorkersAiBinding;
  RELEASE_GATE_OWNERSHIP_SECRET?: string;
  RELEASE_EVIDENCE_CURRENT_KEY?: string; RELEASE_EVIDENCE_PREVIOUS_KEY?: string; RELEASE_EVIDENCE_PREVIOUS_KEY_EXPIRES_AT?: string;
  // The server-to-server credential for the Apify batch channel. Held in the
  // Cloudflare secret store and in Apify's, by Codex. Absent here means the
  // channel simply does not exist and every caller falls back to the public
  // limits — which is the correct behaviour, not a degraded one.
  PREFLIGHT_CHANNEL_TOKEN?: string;
  RELEASE_GATE_WORKFLOW?: { create(input: { params: { runId: string } }): Promise<unknown> };
}

const PRODUCT_ID = "early-3426536d88daa242";
const PRICE_PER_CALL = 0.05;
const FREE_SCAN_LIMIT_PER_HOUR = 5;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
// Sentinel passwordHash for a Google-only account — never a real pbkdf2
// record, so verifyPassword() against it always fails closed. Routes that
// gate on "confirm your current password" (email change, deletion) must
// check for this sentinel explicitly, or a Google-signed-up user can never
// pass them — see accountPage()'s hasPassword branch in web.ts.
const GOOGLE_NO_PASSWORD_HASH = "oauth:google:no-password";

// Per-isolate IP throttle for the free scan (bounded memory, best effort).
const scanHits = new Map<string, number[]>();
function scanAllowed(ip: string): boolean {
  const now = Date.now();
  const hits = (scanHits.get(ip) ?? []).filter(t => now - t < 3_600_000);
  if (hits.length >= FREE_SCAN_LIMIT_PER_HOUR) { scanHits.set(ip, hits); return false; }
  hits.push(now);
  scanHits.set(ip, hits);
  if (scanHits.size > 5_000) scanHits.clear();
  return true;
}

function appDb(env: AppEnv): AppStore | null {
  const db = env.FINANCIAL_DB as ConstructorParameters<typeof AppStore>[0] | undefined;
  if (!db) return null;
  return new AppStore(db);
}

function releaseGateJson(status: number, body: unknown): Response { return new Response(status===204?null:JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
async function subjectDigest(value: string): Promise<string> { const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, "0")).join(""); }
async function hmac(key:string,value:string):Promise<string>{const k=await crypto.subtle.importKey("raw",new TextEncoder().encode(key),{name:"HMAC",hash:"SHA-256"},false,["sign"]);return[...new Uint8Array(await crypto.subtle.sign("HMAC",k,new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,"0")).join("");}
async function evidenceKey(root:string,storeId:string,keyId:"current"|"previous"):Promise<string>{return hmac(root,`agentready-plugin-evidence:${storeId}:${keyId}`);}
export function previousEvidenceKeyAllowed(expiresAt:string|undefined,now=Date.now()):boolean{if(!expiresAt)return false;const expiry=Date.parse(expiresAt);return Number.isFinite(expiry)&&expiry>now;}

function originOf(request: Request): string {
  return new URL(request.url).origin;
}

async function currentUser(request: Request, store: AppStore): Promise<{ userId: string; email: string } | null> {
  const token = readSessionCookie(request);
  if (!token) return null;
  const session = await store.getSession(await hashToken(token));
  if (!session) return null;
  const user = await store.getUser(session.userId);
  return user ? { userId: user.id, email: user.email } : null;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).origin === originOf(request); } catch { return false; }
}

/** 429 with a retry hint. The limits are daily, so the hint is honest. */
function rateLimited(): Response {
  const response = releaseGateJson(429, { code: "TARGET_RATE_LIMITED" });
  const midnight = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(),
                            new Date().getUTCDate() + 1);
  response.headers.set("retry-after", String(Math.max(1, Math.ceil((midnight - Date.now()) / 1000))));
  return response;
}

/** A short, opaque idempotency component. Never logged, never stored raw. */
function headerKey(request: Request, name: string): string | null {
  const value = (request.headers.get(name) ?? "").trim();
  return /^[A-Za-z0-9_.:-]{6,120}$/.test(value) ? value : null;
}

/** The one authenticated batch channel. Named, not inferred from a header. */
const PREFLIGHT_CHANNEL_ID = "apify-batch-preflight";

/** Who is calling, for the purpose of the per-caller limit only.
 *
 * A bearer token that matches the configured channel secret identifies the
 * channel. Everything else — including any User-Agent, any IP, any query
 * string — is an ordinary public caller. There is deliberately no
 * allowlist and no unlimited path: the channel still spends a distributed
 * daily budget that starts at zero. */
function preflightChannel(request: Request, env: AppEnv): "channel" | "public" {
  const secret = env.PREFLIGHT_CHANNEL_TOKEN;
  if (!secret) return "public";
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return "public";
  return constantTimeEqual(header.slice(prefix.length).trim(), secret) ? "channel" : "public";
}

function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Browser-native HTTP Basic Auth — no login form, no session, works the
 * moment ADMIN_PASSWORD is set. Fails closed like OPS_TOKEN: unconfigured
 * means no route, not an open one. Username is ignored (single operator). */
function requireAdmin(request: Request, env: AppEnv): Response | null {
  const configured = env.ADMIN_PASSWORD ?? "";
  if (configured.length < 12) {
    return new Response("admin is not configured", { status: 503 });
  }
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Basic ";
  let suppliedPassword = "";
  if (header.startsWith(prefix)) {
    try {
      const decoded = atob(header.slice(prefix.length));
      suppliedPassword = decoded.slice(decoded.indexOf(":") + 1);
    } catch { /* falls through to the 401 below */ }
  }
  if (!constantTimeEqual(suppliedPassword, configured)) {
    return new Response("unauthorized", { status: 401, headers: { "www-authenticate": 'Basic realm="AgentReady admin"' } });
  }
  return null;
}

function redirectToAccount(kind: "ok" | "error", text: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: `/dashboard/account?notice=${kind}&text=${encodeURIComponent(text)}` },
  });
}

function accountNoticeFromQuery(url: URL): { kind: "ok" | "error"; text: string } | null {
  const kind = url.searchParams.get("notice");
  const text = url.searchParams.get("text");
  if (kind !== "ok" && kind !== "error") return null;
  return { kind, text: text ?? "" };
}

function checkoutConfig(env: AppEnv): CheckoutConfig | null {
  const clientToken = env.PADDLE_CLIENT_TOKEN?.trim();
  // Rejects a secret API key pasted here by mistake — this value is embedded
  // in page HTML for every visitor. See src/core/paddleToken.ts.
  if (!isPublishableClientToken(clientToken)) return null;
  return {
    clientToken,
    prices: {
      report: env.PADDLE_PRICE_REPORT?.trim() || undefined,
      pro: env.PADDLE_PRICE_PRO?.trim() || undefined,
      agency: env.PADDLE_PRICE_AGENCY?.trim() || undefined,
    },
  };
}

/** Deliver any Commerce Readiness Packet already paid for on this store.
 *
 * Scans are anonymous and keyed by URL, so a buyer who paid before running a
 * scan cannot be found from the scan alone — this bridges the two. Failures
 * are swallowed on purpose: a scan must still return its result to the person
 * waiting for it even if an unrelated report delivery breaks. The entitlement
 * stays unfulfilled and the dashboard will retry.
 */
async function settleOwedReportsForStoreUrl(
  app: AppStore, env: AppEnv, storeUrl: string,
): Promise<void> {
  try {
    const userIds = await app.usersWithStoreUrl(storeUrl);
    for (const userId of userIds) {
      const owed = await app.oldestUnfulfilledReport(userId);
      if (!owed) continue;
      const user = await app.getUser(userId);
      if (!user) continue;
      await settleOwedReport(app, env as unknown as PaddleEnv, userId, user.email);
    }
  } catch {
    // Intentionally silent — see the note above.
  }
}

async function storeAgentHits(env: AppEnv, storeId: string): Promise<number> {
  const db = env.FINANCIAL_DB as ConstructorParameters<typeof AppStore>[0] | undefined;
  if (!db) return 0;
  const financial = new (await import("./core/d1Store.ts")).D1FinancialStore(db);
  try {
    return await financial.countRequests(PRODUCT_ID, "store", storeId, Date.now() - 30 * 86_400_000);
  } catch { return 0; }
}

/** One store's tool call, plan limits included.
 *
 * Both request shapes on /mcp/{store} go through this. The limits are the
 * paid boundary of the product, so a second code path reaching runTool()
 * directly would be a way around them rather than a convenience.
 */
export async function callStoreTool(
  store: { plan: PlanKey }, config: ServiceConfig, input: Record<string, unknown>,
): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string; status: number }> {
  const { runTool } = await import("./service.ts");
  const action = typeof input.action === "string" ? input.action : "";

  if (action === "get_feed" || action === "search_products") {
    const result = await runTool(input, config);
    const offers = Array.isArray(result.offers) ? result.offers as Array<Record<string, unknown>> : [];
    const limited = applyOfferLimit(offers, store.plan);
    return { ok: true, result: { ...result, offers: limited.offers, truncated: limited.truncated } };
  }
  if (action === "get_offer" || action === "create_cart_link") {
    const limit = offerLimitFor(store.plan);
    if (limit >= 0) {
      const productId = Number(input.product_id);
      const feed = await runTool({ action: "get_feed" }, config);
      const visibleIds = (Array.isArray(feed.offers) ? feed.offers as Array<{ id?: unknown }> : [])
        .slice(0, limit).map((o) => Number(o.id));
      if (!visibleIds.includes(productId)) {
        return { ok: false, status: 403,
          error: "this product is outside the free plan's visible catalog — upgrade for unlimited offers" };
      }
    }
  }
  return { ok: true, result: await runTool(input, config) };
}

/** The ACP checkout-session tools, in the protocol's own names.
 *
 * ACP's MCP binding maps five REST operations onto five tools with a fixed
 * `{meta, id, payload}` argument shape. Three of them are implemented, and
 * the other two are deliberately absent rather than present and failing:
 * `complete_checkout_session` needs a delegated payment credential this
 * service never handles, and both it and `cancel_checkout_session` presuppose
 * a reservation nothing here makes. A tool that is not offered is a fact an
 * agent can plan around; one that is offered and refuses is a dead end.
 *
 * The names are the specification's rather than ours on purpose. An agent
 * that has read ACP can drive this without being taught anything, which is
 * the entire reason to follow a standard instead of inventing a tool.
 */
function acpTools(config: ServiceConfig, baseUrl: string): McpTool[] {
  const context: QuoteContext = {
    storeUrl: config.storeUrl,
    fetchImpl: (url, init) => fetch(url, init),
    // Handed over as a WooCommerce add-to-cart link, signed and expiring —
    // the existing hand-off. Only for a single line item, because that is the
    // only cart WooCommerce can rebuild from a URL.
    resolveContinueUrl: async (lineItems) => {
      if (lineItems.length !== 1) return null;
      const { runTool } = await import("./service.ts");
      const out = await runTool({
        action: "create_cart_link",
        product_id: Number(lineItems[0].item.id),
        quantity: lineItems[0].item.quantity,
      }, config);
      const url = (out as Record<string, unknown>).cart_url;
      return typeof url === "string" ? url : null;
    },
    links: baseUrl ? [{ type: "seller_shop_policies", url: `${baseUrl}/legal/terms` }] : [],
  };

  const meta = (args: Record<string, unknown>): AcpMeta =>
    (args.meta ?? {}) as AcpMeta;
  const payload = (args: Record<string, unknown>): Record<string, unknown> =>
    (args.payload ?? {}) as Record<string, unknown>;
  const reply = (out: Awaited<ReturnType<typeof createCheckoutSession>>) =>
    out.ok
      ? { ok: true as const, text: JSON.stringify(out.session, null, 2) }
      : { ok: false as const, text: `${out.code}: ${out.message}` };

  const metaSchema = {
    type: "object",
    description: "ACP protocol metadata. api_version is the dated specification version.",
    properties: {
      api_version: { type: "string", description: `ACP version, e.g. "${ACP_API_VERSION}"` },
      idempotency_key: { type: "string" },
      request_id: { type: "string" },
    },
    additionalProperties: true,
  };
  const addressSchema = {
    type: "object",
    description: "Destination. Tax and shipping are not final until this is set.",
    properties: {
      country: { type: "string", description: "ISO 3166-1 alpha-2, e.g. \"US\"" },
      state: { type: "string" }, city: { type: "string" }, postcode: { type: "string" },
      address_1: { type: "string" }, address_2: { type: "string" },
    },
    additionalProperties: true,
  };
  const itemsSchema = {
    type: "array",
    minItems: 1,
    description: "Products and quantities. `id` is the WooCommerce product id from the catalogue tool.",
    items: {
      type: "object",
      properties: { id: { type: "integer", minimum: 1 }, quantity: { type: "integer", minimum: 1 } },
      required: ["id", "quantity"],
      additionalProperties: true,
    },
  };

  return [{
    name: "create_checkout_session",
    description:
      "Price a basket against this WooCommerce store and return an ACP checkout session: line items, the "
      + "store's own tax, its available shipping options, and the landed total in minor currency units. "
      + "Supply a shipping address to get final tax and shipping; without one the total excludes both. "
      + "This never reserves stock and never takes payment — the session reports status "
      + "\"not_ready_for_payment\" and carries continue_url, where the buyer completes the purchase on the "
      + "merchant's own store.",
    inputSchema: {
      type: "object",
      properties: {
        meta: metaSchema,
        payload: {
          type: "object",
          properties: {
            items: itemsSchema,
            fulfillment_details: { type: "object", properties: { shipping_address: addressSchema }, additionalProperties: true },
          },
          required: ["items"],
          additionalProperties: true,
        },
      },
      required: ["payload"],
      additionalProperties: true,
    },
    async run(args) { return reply(await createCheckoutSession(context, meta(args), payload(args))); },
  }, {
    name: "get_checkout_session",
    description: "Re-read a checkout session by id. Prices are recomputed by the store on every read, so a "
      + "quote is current rather than remembered.",
    inputSchema: {
      type: "object",
      properties: { meta: metaSchema, id: { type: "string", description: "Session id from create_checkout_session" } },
      required: ["id"],
      additionalProperties: true,
    },
    async run(args) { return reply(await getCheckoutSession(context, meta(args), String(args.id ?? ""))); },
  }, {
    name: "update_checkout_session",
    description:
      "Change a session and get the repriced result: add items, set or change the shipping address, or choose "
      + "one of the fulfillment_options by its id. Choosing an option is what moves shipping into the total.",
    inputSchema: {
      type: "object",
      properties: {
        meta: metaSchema,
        id: { type: "string", description: "Session id from create_checkout_session" },
        payload: {
          type: "object",
          properties: {
            items: itemsSchema,
            fulfillment_details: { type: "object", properties: { shipping_address: addressSchema }, additionalProperties: true },
            selected_fulfillment_option_ids: {
              type: "array",
              description: "Ids taken from the session's own fulfillment_options — not carrier names.",
              items: { type: "string" },
            },
          },
          additionalProperties: true,
        },
      },
      required: ["id"],
      additionalProperties: true,
    },
    async run(args) { return reply(await updateCheckoutSession(context, meta(args), String(args.id ?? ""), payload(args))); },
  }];
}

/** The store's tool as an MCP client sees it. One tool with an `action`, which
 * matches what the service actually dispatches on — splitting it into five
 * MCP tools would describe a surface this service does not have. */
export function storeMcpTools(store: { plan: PlanKey }, config: ServiceConfig, baseUrl = ""): McpTool[] {
  // Catalogue first, quote second: that is the order the work happens in, and
  // a model reads the list top-down.
  return [{
    name: TOOL_NAME,
    // Shared with the root /mcp surface on purpose: these two drifted apart
    // once, and the root shipped an `action: string` with no enum that no
    // agent could call. One constant, both surfaces.
    description: TOOL_DESCRIPTION,
    inputSchema: TOOL_INPUT_SCHEMA,
    async run(args) {
      const out = await callStoreTool(store, config, args);
      // A plan limit is a real answer the model should relay, not a crash.
      if (!out.ok) return { ok: false, text: out.error };
      return { ok: true, text: JSON.stringify(out.result, null, 2) };
    },
  }, ...acpTools(config, baseUrl)];
}

export async function handleAppRequest(
  request: Request, env: AppEnv, url: URL, guard: RevenueGuard,
): Promise<Response | null> {
  const path = url.pathname;
  const method = request.method;
  const app = appDb(env);

  // Operator-only read of the primary-evidence funnel (scan -> wall ->
  // checkout started -> checkout completed). Bearer-token gated and fails
  // closed like the admin API elsewhere in this project — no token
  // configured means no route, not an open one.
  if (path === "/ops/funnel" && method === "GET") {
    const token = env.OPS_TOKEN ?? "";
    if (token.length < 32) {
      return new Response(JSON.stringify({ error: "ops endpoint is not configured" }), { status: 503, headers: { "content-type": "application/json" } });
    }
    const supplied = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${token}`;
    let mismatch = supplied.length !== expected.length ? 1 : 0;
    for (let i = 0; i < Math.max(supplied.length, expected.length); i++) {
      mismatch |= (supplied.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
    }
    if (mismatch !== 0) {
      return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": "Bearer" } });
    }
    if (!app) return new Response(JSON.stringify({ error: "db not bound" }), { status: 503, headers: { "content-type": "application/json" } });
    const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") ?? 30) || 30));
    const since = Date.now() - days * 86_400_000;
    const funnel = await app.funnelSummary(since);
    const scans = await app.scanOutcomeSummary(since);
    // Counts only. No store URL, caller, request body or raw meta_json leaves
    // this endpoint — an operations read must not become a data export.
    return new Response(JSON.stringify({
      since_days: days,
      funnel,
      scan_outcomes: scans,
      notes: {
        scan_completed: "answered scans only; a scan that could not read the store is in scan_outcomes.abstained",
        attempted: "answered + abstained + unknown",
        unknown: "recorded before the outcome was stored; never counted as a success",
      },
    }, null, 1), { headers: { "content-type": "application/json" } });
  }

  if (path === "/webhooks/paddle" && method === "POST") {
    if (!app) return new Response(JSON.stringify({ error: "db not bound" }), { status: 503, headers: { "content-type": "application/json" } });
    const result = await handlePaddleWebhook(request, env as PaddleEnv, app);
    return new Response(JSON.stringify(result.body), { status: result.status, headers: { "content-type": "application/json" } });
  }

  // ---- operator: admin panel ----
  if (path === "/admin" && method === "GET") {
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    if (!app) return new Response("db not bound", { status: 503 });
    const rows = await app.listUsers();
    const users = await Promise.all(rows.map(async u => {
      const stores = await app.listStores(u.id);
      return { id: u.id, email: u.email, createdAt: u.createdAt, storeCount: stores.length, plan: stores[0]?.plan ?? "free" };
    }));
    return new Response(adminUsersPage(users), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const adminUserMatch = path.match(/^\/admin\/users\/([^/]+)$/);
  if (adminUserMatch && method === "GET") {
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    if (!app) return new Response("db not bound", { status: 503 });
    const user = await app.getUser(adminUserMatch[1]);
    if (!user) return new Response("not found", { status: 404 });
    const stores = await app.listStores(user.id);
    const billingEvents = await app.listBillingEvents(user.id);
    return new Response(adminUserDetailPage(user, stores, billingEvents, null), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const adminResetMatch = path.match(/^\/admin\/users\/([^/]+)\/reset-link$/);
  if (adminResetMatch && method === "POST") {
    const denied = requireAdmin(request, env);
    if (denied) return denied;
    if (!app) return new Response("db not bound", { status: 503 });
    const user = await app.getUser(adminResetMatch[1]);
    if (!user) return new Response("not found", { status: 404 });
    const token = newSessionToken();
    await app.createPasswordReset(user.id, await hashToken(token), PASSWORD_RESET_TTL_MS);
    const base = (env.PUBLIC_BASE_URL ?? originOf(request)).replace(/\/+$/, "");
    const resetLink = `${base}/reset-password?token=${encodeURIComponent(token)}`;
    const stores = await app.listStores(user.id);
    const billingEvents = await app.listBillingEvents(user.id);
    return new Response(adminUserDetailPage(user, stores, billingEvents, resetLink), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // ---- Release Gate v2: intentionally separate from /api/scan, catalogue
  // MCP, Paddle packets, and every financial settlement path. ----
  if (path === "/api/v2/release-evidence" && method === "POST") {
    if (!app) return releaseGateJson(503,{code:"INFRA_PERSISTENCE_FAILED"});
    if(!/^application\/json(?:;|$)/i.test(request.headers.get("content-type")??""))return releaseGateJson(415,{code:"EVIDENCE_INVALID"});if(Number(request.headers.get("content-length")??"0")>16_384)return releaseGateJson(413,{code:"EVIDENCE_INVALID"});
    try { const raw=await request.text();if(raw.length>16_384)return releaseGateJson(413,{code:"EVIDENCE_INVALID"});const packet=await validatePluginEvidence(JSON.parse(raw));const store=await app.getStore(packet.store_id);if(!store)return releaseGateJson(403,{code:"EVIDENCE_INVALID"});const root=packet.key_id==="current"?env.RELEASE_EVIDENCE_CURRENT_KEY:(previousEvidenceKeyAllowed(env.RELEASE_EVIDENCE_PREVIOUS_KEY_EXPIRES_AT)?env.RELEASE_EVIDENCE_PREVIOUS_KEY:undefined);const sig=request.headers.get("x-agentready-evidence-signature")??"";if(!root||sig.length!==64||!constantTimeEqual(sig,await hmac(await evidenceKey(root,store.id,packet.key_id),canonicalPluginEvidence(packet))))return releaseGateJson(403,{code:"EVIDENCE_INVALID"});const receipt=crypto.randomUUID();const stored=await app.recordPluginEvidence(receipt,store.id,store.userId,packet.nonce,packet.digest,JSON.stringify(packet),Date.parse(packet.expires_at),Date.parse(packet.generated_at));if(stored==="failed")return releaseGateJson(503,{code:"INFRA_PERSISTENCE_FAILED"});if(stored==="conflict")return releaseGateJson(409,{code:"EVIDENCE_CONFLICT"});return releaseGateJson(stored==="stored"?201:409,{code:stored==="stored"?"ACCEPTED":"REPLAY",...(stored==="stored"?{receipt_id:receipt,schema_version:packet.schema_version}:{})});
    } catch { return releaseGateJson(400,{code:"EVIDENCE_INVALID"}); }
  }
  if (path === "/api/v2/release-api-tokens" && method === "GET") {
    if(!app)return releaseGateJson(503,{code:"INFRA_PERSISTENCE_FAILED"});const user=await currentUser(request,app);if(!user)return releaseGateJson(401,{code:"AUTH_REQUIRED"});return releaseGateJson(200,{tokens:(await app.listReleaseApiTokens(user.userId)).map(publicToken)});
  }
  if (path === "/api/v2/release-api-tokens" && method === "POST") {
    if(!app)return releaseGateJson(503,{code:"INFRA_PERSISTENCE_FAILED"});const user=await currentUser(request,app);if(!user)return releaseGateJson(401,{code:"AUTH_REQUIRED"});try{const created=await createReleaseToken(app,user.userId,parseTokenCreate(await request.json()));return releaseGateJson(201,{token:created.token,token_metadata:publicToken(created.row)});}catch(error){return releaseGateJson(400,{code:error instanceof Error?error.message:"INVALID_BODY"});}
  }
  const tokenPath=path.match(/^\/api\/v2\/release-api-tokens\/([A-Za-z0-9_-]{8,100})$/);
  if(tokenPath&&method==="DELETE"){
    if(!app)return releaseGateJson(503,{code:"INFRA_PERSISTENCE_FAILED"});const user=await currentUser(request,app);if(!user)return releaseGateJson(401,{code:"AUTH_REQUIRED"});return releaseGateJson(await app.revokeReleaseApiToken(tokenPath[1],user.userId)?204:404,{});
  }
  const rotatePath=path.match(/^\/api\/v2\/release-api-tokens\/([A-Za-z0-9_-]{8,100})\/rotate$/);
  if(rotatePath&&method==="POST"){
    if(!app)return releaseGateJson(503,{code:"INFRA_PERSISTENCE_FAILED"});const user=await currentUser(request,app);if(!user)return releaseGateJson(401,{code:"AUTH_REQUIRED"});const prior=(await app.listReleaseApiTokens(user.userId)).find(t=>t.id===rotatePath[1]&&t.revokedAt===null);if(!prior)return releaseGateJson(404,{code:"TOKEN_NOT_FOUND"});try{const created=await rotateReleaseToken(app,user.userId,prior);return releaseGateJson(201,{token:created.token,token_metadata:publicToken(created.row),replaced_token_id:prior.id});}catch{return releaseGateJson(503,{code:"INFRA_PERSISTENCE_FAILED"});}
  }
  const releaseCredentialsPath = path.match(/^\/api\/v2\/stores\/([^/]+)\/release-credentials$/);
  if (releaseCredentialsPath && method === "POST") {
    if (!app) return releaseGateJson(503, { code: "INFRA_PERSISTENCE_FAILED" });
    const user = await currentUser(request, app);
    if (!user) return releaseGateJson(401, { code: "AUTH_REQUIRED" });
    if (!sameOrigin(request)) return releaseGateJson(403, { code: "ORIGIN_REJECTED" });
    const store = await app.getStore(releaseCredentialsPath[1]);
    if (!store || store.userId !== user.userId) return releaseGateJson(404, { code: "STORE_NOT_FOUND" });
    if (!env.RELEASE_GATE_OWNERSHIP_SECRET || !env.RELEASE_EVIDENCE_CURRENT_KEY) {
      return releaseGateJson(503, { code: "CREDENTIALS_UNAVAILABLE" });
    }
    const endpoint = (env.PUBLIC_BASE_URL ?? originOf(request)).replace(/\/+$/, "");
    return releaseGateJson(200, {
      store_id: store.id,
      endpoint,
      ownership_key: await deriveOwnershipKey(env.RELEASE_GATE_OWNERSHIP_SECRET, store.id),
      evidence_key_id: "current",
      evidence_key: await evidenceKey(env.RELEASE_EVIDENCE_CURRENT_KEY, store.id, "current"),
    });
  }
  if (path === "/api/v2/preflight" && method === "POST") {
    if (!app) return releaseGateJson(503, { code: "INFRA_PERSISTENCE_FAILED" });
    // A bearer token that matches the configured channel secret replaces ONLY
    // the per-IP limit — the Apify Actor shares an IP pool, so that counter
    // fails a caller for other people's traffic. The per-target-origin limit
    // is untouched: it protects merchants' stores, not our capacity.
    const channel = preflightChannel(request, env);
    try {
      const raw = await request.json() as Record<string, unknown>;
      // Idempotency keys are the channel's, not part of the public contract.
      const runKey = channel === "channel" ? headerKey(request, "x-agentready-run") : null;
      const itemKey = channel === "channel" ? headerKey(request, "x-agentready-item") : null;
      const input = parsePreflightInput(raw);
      const day = new Date().toISOString().slice(0, 10);

      // A replay returns the outcome the first attempt reached, spends no
      // budget and can never become a second future charge.
      if (runKey && itemKey) {
        const seen = await app.recallChannelOutcome(PREFLIGHT_CHANNEL_ID, runKey, itemKey);
        if (seen) {
          return releaseGateJson(seen.outcome === "USEFUL" ? 200 : 409, {
            code: "REPLAYED", outcome: seen.outcome, billable: seen.billable,
            store_origin: input.store_origin,
          });
        }
      }

      const originOk = await app.incrementReleaseUsage(
        day, "preflight-origin", await subjectDigest(input.store_origin), 3);
      if (!originOk) return rateLimited();

      if (channel === "channel") {
        // Distributed, and zero until Codex configures a cap.
        const budgetOk = await app.consumeChannelBudget(day, PREFLIGHT_CHANNEL_ID);
        if (!budgetOk) return rateLimited();
      } else {
        const ip = request.headers.get("cf-connecting-ip") ?? "unavailable";
        const ipOk = await app.incrementReleaseUsage(day, "preflight-ip", await subjectDigest(ip), 10);
        if (!ipOk) return rateLimited();
      }

      const result = await runPreflight(input);
      if (runKey && itemKey) {
        const answered = result.state !== "BLOCKED" && result.state !== "UNMEASURED";
        await app.rememberChannelOutcome(PREFLIGHT_CHANNEL_ID, runKey, itemKey,
          answered ? "USEFUL" : "ABSTAINED", answered);
      }
      return releaseGateJson(200, result);
    } catch (error) { return releaseGateJson(400, { code: error instanceof ContractError ? error.code : "INVALID_BODY" }); }
  }
  const ownershipPath = path.match(/^\/api\/v2\/stores\/([^/]+)\/ownership-challenges$/);
  if (ownershipPath && method === "POST") {
    if (!app) return releaseGateJson(503, { code: "INFRA_PERSISTENCE_FAILED" }); const user = await currentUser(request, app); if (!user) return releaseGateJson(401, { code: "AUTH_REQUIRED" });
    const store = await app.getStore(ownershipPath[1]); if (!store || store.userId !== user.userId) return releaseGateJson(404, { code: "STORE_NOT_FOUND" });
    const challenge = await new ReleaseGateStore(app).createChallenge(store.id, user.userId);
    return releaseGateJson(201, { challenge_id: challenge.id, challenge: challenge.challenge, expires_at: new Date(challenge.expiresAt).toISOString(), proof_path: "/.well-known/agentready-ownership" });
  }
  const verifyPath = path.match(/^\/api\/v2\/stores\/([^/]+)\/ownership-challenges\/([^/]+)\/verify$/);
  if (verifyPath && method === "POST") {
    if (!app) return releaseGateJson(503, { code: "INFRA_PERSISTENCE_FAILED" }); const user = await currentUser(request, app); if (!user) return releaseGateJson(401, { code: "AUTH_REQUIRED" });
    const store = await app.getStore(verifyPath[1]); if (!store || store.userId !== user.userId) return releaseGateJson(404, { code: "STORE_NOT_FOUND" });
    const body = await request.json().catch(() => null) as Record<string, unknown> | null; if (!body || Object.keys(body).some(k => k !== "challenge" && k !== "proof") || typeof body.challenge !== "string" || typeof body.proof !== "string") return releaseGateJson(400, { code: "INVALID_BODY" });
    const verified = await new ReleaseGateStore(app).verifyChallenge(verifyPath[2],store.id,user.userId,body.challenge,body.proof,env.RELEASE_GATE_OWNERSHIP_SECRET ?? "");
    return releaseGateJson(verified ? 200 : 403, { verified });
  }
  if (path === "/api/v2/acceptance-runs" && method === "POST") {
    if (!app) return releaseGateJson(503, { code: "INFRA_PERSISTENCE_FAILED" }); const user = await currentUser(request, app); if (!user) return releaseGateJson(401, { code: "AUTH_REQUIRED" });
    try { const input = parseAcceptanceRunInput(await request.json()); const store = await app.getStore(input.store_id); if (!store || store.userId !== user.userId) return releaseGateJson(404, { code: "STORE_NOT_FOUND" });
      const gate = new ReleaseGateStore(app); if (!await app.hasVerifiedReleaseOwnership(store.id,user.userId)) return releaseGateJson(403, { code: "OWNERSHIP_REQUIRED" });const generation=await app.getActivePluginEvidence(store.id,user.userId);if(!generation)return releaseGateJson(409,{code:"EVIDENCE_REQUIRED",state:"BLOCKED",settlement:"disabled"});let signed;try{signed=await validatePluginEvidence(JSON.parse(generation.safePacket));}catch{return releaseGateJson(409,{code:"EVIDENCE_REQUIRED",state:"UNMEASURED",settlement:"disabled"});}if(signed.digest!==generation.digest||!evidenceCoversFamilies(signed,input.requested_families))return releaseGateJson(409,{code:"EVIDENCE_REQUIRED",state:"UNMEASURED",settlement:"disabled"});
      if (!env.RELEASE_GATE_WORKFLOW) return releaseGateJson(503, { code: "WORKFLOW_UNAVAILABLE", settlement: "disabled" });
      const run = await gate.createOrGetRun(user.userId,input);
      try { await env.RELEASE_GATE_WORKFLOW.create({ params: { runId: run.id } }); }
      catch { await gate.markDispatchFailed(run); return releaseGateJson(503, { code: "WORKFLOW_DISPATCH_FAILED", run_id:run.id, state:"TERMINAL", terminal_state:"INFRA_ERROR", settlement: "disabled" }); }
      return releaseGateJson(202, { run_id: run.id, state: run.state, settlement: "disabled" });
    } catch (error) { return releaseGateJson(400, { code: error instanceof ContractError ? error.code : "INVALID_BODY" }); }
  }
  const runPath = path.match(/^\/api\/v2\/acceptance-runs\/([^/]+)$/);
  if (runPath && method === "GET") {
    if (!app) return releaseGateJson(503, { code: "INFRA_PERSISTENCE_FAILED" }); const user = await currentUser(request, app); if (!user) return releaseGateJson(401, { code: "AUTH_REQUIRED" }); const run = await new ReleaseGateStore(app).getRun(runPath[1],user.userId); return run ? releaseGateJson(200,{ run_id:run.id,state:run.state,terminal_state:run.terminalState,evidence_digest:run.evidenceDigest }) : releaseGateJson(404,{ code:"RUN_NOT_FOUND" });
  }
  const claimPath = path.match(/^\/api\/v2\/acceptance-runs\/([^/]+)\/claim-result$/);
  if (claimPath && method === "POST") {
    if (!app) return releaseGateJson(503, { code: "INFRA_PERSISTENCE_FAILED" }); const user = await currentUser(request, app); if (!user) return releaseGateJson(401, { code: "AUTH_REQUIRED" }); const gate = new ReleaseGateStore(app); const run = await gate.getRun(claimPath[1],user.userId); if (!run) return releaseGateJson(404,{code:"RUN_NOT_FOUND"}); if (run.state !== "TERMINAL") return releaseGateJson(409,{code:"RESULT_NOT_READY"});
    const claim = await gate.claim(run,"direct",await subjectDigest(user.userId)); return releaseGateJson(200,{ packet:claim.packet, delivery: claim.firstDelivery ? "FIRST" : "REPLAY", billable_eligibility: claim.billable ? "ELIGIBLE_ON_FIRST_DELIVERY" : "NOT_BILLABLE", settlement:"disabled" });
  }
  if (path === "/api/v2/comparisons" && method === "POST") {
    if (!app) return releaseGateJson(503,{code:"INFRA_PERSISTENCE_FAILED"}); const user = await currentUser(request,app); if (!user) return releaseGateJson(401,{code:"AUTH_REQUIRED"}); const body = await request.json().catch(() => null) as Record<string,unknown> | null; if (!body || Object.keys(body).some(k=>k!=="base_run_id"&&k!=="current_run_id") || typeof body.base_run_id !== "string" || typeof body.current_run_id !== "string") return releaseGateJson(400,{code:"INVALID_BODY"});
    const gate = new ReleaseGateStore(app); const [base,current] = await Promise.all([gate.getRun(body.base_run_id,user.userId),gate.getRun(body.current_run_id,user.userId)]); if (!base || !current || base.storeId !== current.storeId) return releaseGateJson(404,{code:"COMPARISON_NOT_FOUND"}); const [baseJson,currentJson] = await Promise.all([app.getReleaseEvidence(base.id),app.getReleaseEvidence(current.id)]); if (!baseJson || !currentJson) return releaseGateJson(409,{code:"RESULT_NOT_READY"}); const b=JSON.parse(baseJson) as {checks:Array<{id:string;state:string}>}; const n=JSON.parse(currentJson) as {checks:Array<{id:string;state:string}>}; const old=new Map(b.checks.map(x=>[x.id,x.state])); return releaseGateJson(200,{ base_run_id:base.id,current_run_id:current.id,new_failures:n.checks.filter(x=>x.state==="FAIL"&&old.get(x.id)!=="FAIL").map(x=>x.id),recovered:n.checks.filter(x=>x.state==="PASS"&&old.get(x.id)==="FAIL").map(x=>x.id),evidence_hashes:[base.evidenceDigest,current.evidenceDigest] });
  }
  if (path === "/dashboard/release-gate" && method === "GET") {
    if (!app) return new Response("Release Gate database is unavailable", { status: 503 }); const user = await currentUser(request,app); if (!user) return new Response(null,{status:302,headers:{location:"/login"}});
    const runs = await app.listReleaseRuns(user.userId); const rows = runs.map(run => `<tr><td>${escapeHtml(run.id)}</td><td>${escapeHtml(run.state)}</td><td>${escapeHtml(run.terminalState ?? "—")}</td><td>${run.evidenceDigest ? "available" : "—"}</td></tr>`).join("") || "<tr><td colspan=\"4\">No Release Gate runs yet. Start with a free Store Preflight.</td></tr>";
    return new Response(`<!doctype html><title>Release Gate — AgentReady Woo</title><main><h1>Release Gate</h1><p>Ownership-authorized release decisions. No order or payment is created.</p><table><thead><tr><th>Run</th><th>Progress</th><th>Decision</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table><p>Settlement is disabled pending owner approval.</p></main>`,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
  }

  // ---- public: scan ----
  if (path === "/scan" && method === "GET") {
    return new Response(null, { status: 302, headers: { location: "/#scan" } });
  }
  if (path === "/api/scan" && method === "POST") {
    const ip = request.headers.get("cf-connecting-ip") ?? "local";
    if (!scanAllowed(ip)) {
      return new Response(JSON.stringify({ error: "scan limit reached — try again later" }), { status: 429, headers: { "content-type": "application/json" } });
    }
    let storeUrl = "";
    try {
      const body = await request.json() as { store_url?: string };
      storeUrl = normalizeStoreUrl(body.store_url ?? "");
    } catch {
      return new Response(JSON.stringify({ error: "store_url must be an https:// URL" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    const result = await scanStore(storeUrl, fetch);
    let id = "";
    if (app) {
      id = crypto.randomUUID();
      // A scan that abstained has no score. -1 is the ledger's "not scored"
      // sentinel, chosen because the column is NOT NULL and 0 is a real score.
      // The funnel kind stays `scan_completed` because funnel_events carries a
      // CHECK(kind IN (...)) constraint that only a table rebuild can widen.
      // That is a storage limit, not a reporting one: the outcome is written to
      // `meta.state`, `funnelSummary` excludes an abstained row from its
      // scan_completed count, and `scanOutcomeSummary` reports answered,
      // abstained and unknown separately. Do not read the raw `kind` as a
      // count of scans that answered.
      await app.saveScan({ id, storeUrl, score: result.score ?? -1, resultJson: JSON.stringify(result), createdAt: Date.now() });
      await app.recordFunnelEvent({ kind: "scan_completed", meta: { store_url: storeUrl, score: result.score ?? -1, state: result.state, via: "api" } });
      await settleOwedReportsForStoreUrl(app, env, storeUrl);
    }
    return new Response(JSON.stringify({ ...result, id: id || undefined }), { headers: { "content-type": "application/json" } });
  }
  if (path === "/scan" && method === "POST") {
    const ip = request.headers.get("cf-connecting-ip") ?? "local";
    if (!scanAllowed(ip)) {
      return new Response(scanFormPage("rate_limited"), { status: 429, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const form = await readForm(request);
    const entered = form.get("store_url") ?? "";
    let storeUrl = "";
    // A rejected address used to come back as the blank form: same page, same
    // empty field, nothing said. It reads as a page that did nothing.
    try { storeUrl = normalizeStoreUrl(entered); } catch {
      return new Response(scanFormPage("invalid_url", entered), {
        status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const result = await scanStore(storeUrl, fetch);
    let id = "";
    if (app) {
      id = crypto.randomUUID();
      await app.saveScan({ id, storeUrl, score: result.score ?? -1, resultJson: JSON.stringify(result), createdAt: Date.now() });
      await app.recordFunnelEvent({ kind: "scan_completed", meta: { store_url: storeUrl, score: result.score ?? -1, state: result.state, via: "form" } });
      await settleOwedReportsForStoreUrl(app, env, storeUrl);
    }
    return new Response(scanResultPage(result), {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", ...(id ? { "x-scan-id": id } : {}) },
    });
  }
  if (path.startsWith("/scan/") && method === "GET" && app) {
    const scan = await app.getScan(path.slice("/scan/".length));
    if (!scan) return new Response("not found", { status: 404 });
    const result = JSON.parse(scan.resultJson) as ScanResult;
    return new Response(scanResultPage(result), { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  // ---- public: per-store agent surface ----
  if (path.startsWith("/feed/") && method === "GET" && app) {
    const store = await app.getStore(path.slice("/feed/".length));
    if (!store || store.status !== "active") return new Response(JSON.stringify({ error: "store not found" }), { status: 404, headers: { "content-type": "application/json" } });
    const { config } = await storeServiceConfig(store, env as Record<string, string | undefined>, originOf(request));
    const { runTool } = await import("./service.ts");
    let output: { offers?: unknown };
    try {
      output = await runTool({ action: "get_feed", per_page: 100, page: 1 }, config);
    } catch {
      return new Response(JSON.stringify({
        store: store.name, url: store.storeUrl, plan: store.plan,
        offers: [], offer_limit: applyOfferLimit([], store.plan).limit,
        truncated: false,
        error: "feed temporarily unavailable — the store could not be reached. Check the store connection in the dashboard.",
      }, null, 1), { status: 502, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
    }
    const offers = Array.isArray(output.offers) ? output.offers as Array<Record<string, unknown>> : [];
    const limited = applyOfferLimit(offers, store.plan);
    if (limited.truncated) {
      await app.recordFunnelEvent({
        kind: "wall_shown", storeId: store.id, plan: store.plan,
        meta: { offer_count: offers.length, limit: limited.limit },
      });
    }
    return new Response(JSON.stringify({
      store: store.name, url: store.storeUrl,
      plan: store.plan,
      offers: limited.offers,
      offer_limit: limited.limit,
      truncated: limited.truncated,
      note: limited.truncated ? "Free plan shows the top 25 products — upgrade for unlimited offers." : undefined,
    }, null, 1), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" } });
  }
  // Per-store commerce tool surface (search/offer/cart-link for one
  // merchant's own catalog): gated by the store's Paddle plan, the same
  // top-25 free-tier limit /feed already enforces — NOT by the x402
  // per-call payment rail. That rail belongs to a different product (the
  // global readiness-scan tool at POST /mcp, index.ts); a merchant who
  // paid via Paddle for "unlimited offers, signed cart handoff" expects
  // agents to actually be able to call this, not hit an unrelated wall.
  // What this seller speaks, in ACP's own discovery shape. Served beside the
  // endpoint rather than at /.well-known/acp.json, because that path belongs
  // to the merchant's domain and this service is not it.
  const discoveryMatch = path.match(/^\/mcp\/([^/]+)\/discovery$/);
  if (discoveryMatch && method === "GET" && app) {
    const store = await app.getStore(discoveryMatch[1]);
    if (!store || store.status !== "active") return new Response(JSON.stringify({ error: "store not found" }), { status: 404, headers: { "content-type": "application/json" } });
    const endpoint = `${originOf(request)}/mcp/${discoveryMatch[1]}`;
    return new Response(JSON.stringify(discoveryDocument(endpoint), null, 2), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=300" },
    });
  }

  // MCP here is request/response only — there is no server-to-client stream to
  // open, so a GET is answered rather than left to fall through to a 404, and
  // it says where the description of this endpoint lives.
  if (/^\/mcp\/[^/]+$/.test(path) && method === "GET") {
    return new Response(JSON.stringify({
      jsonrpc: "2.0", id: null,
      error: { code: -32600, message: "this endpoint accepts POST only; it offers no server-to-client stream" },
    }), {
      status: 405,
      headers: {
        "content-type": "application/json",
        allow: "POST",
        link: `<${originOf(request)}${path}/discovery>; rel="service-desc"`,
      },
    });
  }

  if (path.startsWith("/mcp/") && method === "POST" && app) {
    const store = await app.getStore(path.slice("/mcp/".length));
    if (!store || store.status !== "active") return new Response(JSON.stringify({ error: "store not found" }), { status: 404, headers: { "content-type": "application/json" } });
    const { config } = await storeServiceConfig(store, env as Record<string, string | undefined>, originOf(request));
    const raw = await request.json().catch(() => null) as unknown;

    // A real MCP client speaks JSON-RPC 2.0. This endpoint was documented as
    // a Model Context Protocol endpoint while answering only {tool, input},
    // so no client could connect. Both shapes work now, and BOTH run through
    // callStoreTool below — the plan limits are enforced there, and a second
    // code path would be a way around them.
    if (isJsonRpc(raw)) {
      const reply = await handleJsonRpc(raw, {
        name: AGENTREADY_SERVER_NAME,
        version: AGENTREADY_VERSION,
        instructions: "Reads one WooCommerce store's public catalogue for shopping agents and prices a basket against it. "
          + "The catalogue tool searches products, fetches an offer, and creates a signed cart link. The ACP checkout-session "
          + `tools (Agentic Commerce Protocol ${ACP_API_VERSION}) return the store's own tax, shipping options and landed total — `
          + "the part that cannot be worked out from a catalogue. No stock is reserved and no payment is taken: sessions stay at "
          + "\"not_ready_for_payment\" and the buyer completes the purchase on the merchant's own store.",
      }, storeMcpTools(store, config, originOf(request)));
      if (reply === null) return new Response(null, { status: 202 });
      return new Response(JSON.stringify(reply), { headers: { "content-type": "application/json" } });
    }

    const body = (raw ?? {}) as { tool: string; input: Record<string, unknown> };
    if (body.tool !== TOOL_NAME) {
      return new Response(JSON.stringify({ error: `unknown tool: ${body.tool}` }), { status: 400, headers: { "content-type": "application/json" } });
    }
    try {
      const out = await callStoreTool(store, config, body.input ?? {});
      if (!out.ok) return new Response(JSON.stringify({ error: out.error }), { status: out.status, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ result: out.result }), { headers: { "content-type": "application/json" } });
    } catch (error) {
      return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "tool call failed" }), { status: 400, headers: { "content-type": "application/json" } });
    }
  }

  // ---- account: signup / login / logout ----
  const googleOn = Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  if (path === "/signup" && method === "GET") {
    return new Response(signupPage("", "", googleOn), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (path === "/signup" && method === "POST") {
    if (!app) return new Response("db not bound", { status: 503 });
    if (!sameOrigin(request)) return new Response("cross-origin form rejected", { status: 403 });
    const form = await readForm(request);
    const email = (form.get("email") ?? "").trim().toLowerCase();
    const password = form.get("password") ?? "";
    if (form.get("accept_terms") !== "on") return new Response(signupPage("Please agree to the Terms and Privacy Policy to continue.", email, googleOn), { headers: { "content-type": "text/html; charset=utf-8" } });
    if (!isValidEmail(email)) return new Response(signupPage("Enter a valid email address.", email, googleOn), { headers: { "content-type": "text/html; charset=utf-8" } });
    if (await app.getUserByEmail(email)) return new Response(signupPage("An account with this email already exists. Log in instead.", email, googleOn), { headers: { "content-type": "text/html; charset=utf-8" } });
    let passwordHash: string;
    try { passwordHash = await hashPassword(password); } catch (error) {
      return new Response(signupPage("Password must be 8-200 characters.", email, googleOn), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const userId = crypto.randomUUID();
    if (!await app.createUser(userId, email, passwordHash)) {
      return new Response(signupPage("Could not create the account — try again.", email, googleOn), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    // Someone can pay before they register, or pay under a different address
    // and then sign in with it. Collect it instead of stranding the payment.
    await claimPurchases(app, env as unknown as PaddleEnv, userId, email);
    const token = newSessionToken();
    await app.createSession({ tokenHash: await hashToken(token), userId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
    return new Response(null, { status: 302, headers: { location: "/dashboard", "set-cookie": sessionCookie(token) } });
  }
  if (path === "/login" && method === "GET") {
    return new Response(loginPage("", "", googleOn), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (path === "/login" && method === "POST") {
    if (!app) return new Response("db not bound", { status: 503 });
    if (!sameOrigin(request)) return new Response("cross-origin form rejected", { status: 403 });
    const form = await readForm(request);
    const email = (form.get("email") ?? "").trim().toLowerCase();
    const password = form.get("password") ?? "";
    const user = await app.getUserByEmail(email);
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !ok) return new Response(loginPage("Wrong email or password.", email, googleOn), { headers: { "content-type": "text/html; charset=utf-8" } });
    await claimPurchases(app, env as unknown as PaddleEnv, user.id, email);
    const token = newSessionToken();
    await app.createSession({ tokenHash: await hashToken(token), userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
    return new Response(null, { status: 302, headers: { location: "/dashboard", "set-cookie": sessionCookie(token) } });
  }
  if (path === "/logout") {
    if (app) {
      const token = readSessionCookie(request);
      if (token) await app.deleteSession(await hashToken(token));
    }
    return new Response(null, { status: 302, headers: { location: "/login", "set-cookie": clearedSessionCookie() } });
  }

  // ---- account: Google OAuth ----
  if (path === "/auth/google/start" && method === "GET") {
    if (!googleOn || !app) return new Response("Google sign-in is not configured.", { status: 404 });
    const state = crypto.randomUUID();
    const params = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      redirect_uri: `${originOf(request)}/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
    });
    return new Response(null, { status: 302, headers: {
      location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      "set-cookie": `g_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600; Path=/`,
    } });
  }
  if (path === "/auth/google/callback" && method === "GET") {
    const fail = (msg: string) => new Response(loginPage(msg, "", googleOn), { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
    if (!googleOn || !app) return new Response("Google sign-in is not configured.", { status: 404 });
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "";
    const cookieState = (request.headers.get("cookie") ?? "").match(/g_state=([0-9a-f-]{36})/)?.[1] ?? "";
    if (!code || !state || state !== cookieState) return fail("Google sign-in failed — please try again.");
    let idToken: string | undefined;
    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: `${originOf(request)}/auth/google/callback`, grant_type: "authorization_code",
        }),
      });
      idToken = ((await tokenRes.json()) as { id_token?: string }).id_token;
    } catch { return fail("Google sign-in failed — please try again."); }
    if (!idToken) return fail("Google sign-in failed — please try again.");
    const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
    if (!infoRes.ok) return fail("Google sign-in failed — please try again.");
    const info = await infoRes.json() as { aud?: string; email?: string; email_verified?: string | boolean };
    if (info.aud !== env.GOOGLE_CLIENT_ID || !info.email) return fail("Google account could not be verified.");
    if (info.email_verified !== true && info.email_verified !== "true") return fail("Your Google email is not verified — verify it at Google first.");
    const email = info.email.toLowerCase();
    let user = await app.getUserByEmail(email);
    if (!user) {
      const userId = crypto.randomUUID();
      if (!await app.createUser(userId, email, GOOGLE_NO_PASSWORD_HASH)) return fail("Could not create the account — try again.");
      user = { id: userId, email, passwordHash: GOOGLE_NO_PASSWORD_HASH, createdAt: Date.now() };
    }
    await claimPurchases(app, env as unknown as PaddleEnv, user.id, email);
    const token = newSessionToken();
    await app.createSession({ tokenHash: await hashToken(token), userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
    // Two cookies (the new session, and clearing the OAuth state nonce) need
    // two separate Set-Cookie headers — concatenating them into one value
    // corrupts attribute parsing (a stray "Max-Age=0" from the g_state clear
    // would win over the session's real TTL and kill the login instantly).
    const headers = new Headers({ location: "/dashboard" });
    headers.append("set-cookie", sessionCookie(token));
    headers.append("set-cookie", "g_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
    return new Response(null, { status: 302, headers });
  }

  // ---- account: forgot / reset password ----
  if (path === "/forgot-password" && method === "GET") {
    return new Response(forgotPasswordPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (path === "/forgot-password" && method === "POST") {
    if (!app) return new Response("db not bound", { status: 503 });
    if (!sameOrigin(request)) return new Response("cross-origin form rejected", { status: 403 });
    const form = await readForm(request);
    const email = (form.get("email") ?? "").trim().toLowerCase();
    // Same response whether or not the email exists — the only difference
    // is whether anything happens behind it. This is what stops the
    // endpoint being usable to test which emails have an account.
    const user = isValidEmail(email) ? await app.getUserByEmail(email) : null;
    if (user) {
      const token = newSessionToken();
      await app.createPasswordReset(user.id, await hashToken(token), PASSWORD_RESET_TTL_MS);
      const base = (env.PUBLIC_BASE_URL ?? originOf(request)).replace(/\/+$/, "");
      const resetUrl = `${base}/reset-password?token=${encodeURIComponent(token)}`;
      await sendEmail(env, user.email, "Reset your AgentReady password", passwordResetEmailHtml(resetUrl));
    }
    return new Response(forgotPasswordPage(true), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (path === "/reset-password" && method === "GET") {
    const token = url.searchParams.get("token") ?? "";
    if (!token) return new Response(resetLinkExpiredPage(), { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
    if (app) {
      const reset = await app.getValidPasswordReset(await hashToken(token));
      if (!reset) return new Response(resetLinkExpiredPage(), { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response(resetPasswordPage(token), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (path === "/reset-password" && method === "POST") {
    if (!app) return new Response("db not bound", { status: 503 });
    if (!sameOrigin(request)) return new Response("cross-origin form rejected", { status: 403 });
    const form = await readForm(request);
    const token = form.get("token") ?? "";
    const password = form.get("password") ?? "";
    const tokenHash = await hashToken(token);
    const reset = await app.getValidPasswordReset(tokenHash);
    if (!reset) return new Response(resetLinkExpiredPage(), { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
    let passwordHash: string;
    try { passwordHash = await hashPassword(password); } catch {
      return new Response(resetPasswordPage(token, "Password must be 8-200 characters."), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    // Consume first: if two requests race on the same token, only one can
    // win the single-use row, so only one password change actually lands.
    if (!await app.consumePasswordReset(tokenHash)) {
      return new Response(resetLinkExpiredPage(), { status: 400, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    await app.updateUserPassword(reset.userId, passwordHash);
    // Every existing session is invalidated by a password reset — the
    // whole point is "someone other than the account owner might have had
    // access"; leaving old sessions alive would defeat that.
    await app.deleteAllSessionsForUser(reset.userId);
    return new Response(null, { status: 302, headers: { location: "/login" } });
  }

  // ---- authenticated: dashboard ----
  if ((path === "/dashboard" || path.startsWith("/dashboard/")) && app) {
    const session = await currentUser(request, app);
    if (!session) return new Response(null, { status: 302, headers: { location: "/login" } });

    if (path === "/dashboard" && method === "GET") {
      const stores = await app.listStores(session.userId);
      const cards: string[] = [];
      for (const store of stores) {
        cards.push(storeCard({
          id: store.id, name: store.name, storeUrl: store.storeUrl, plan: store.plan,
          publicBaseUrl: (env.PUBLIC_BASE_URL ?? originOf(request)).replace(/\/+$/, ""),
          agentHits: await storeAgentHits(env, store.id),
        }));
      }
      const plan: PlanKey = stores[0]?.plan ?? "free";
      const canAdd = stores.length < (plan === "agency" ? 25 : 1);
      const addCta = canAdd
        ? `<a class="btn" href="/dashboard/store">Connect a store</a>`
        : `<div class="card"><strong>Store limit reached on the ${escapeHtml(plan)} plan.</strong>
           <p class="sub" style="margin:8px 0 12px">${plan === "free" ? "Upgrade to Agency for 25 stores, or manage your existing store." : "Agency supports 25 stores."}</p>
           <a class="btn btn-line" href="/dashboard/billing">Billing</a></div>`;
      // Only a connected, free-plan store has actually hit the 25-product
      // cap — a brand-new account with zero stores hasn't earned this pitch
      // yet, and a Pro/Agency account shouldn't see its own upgrade offer.
      const checkout = checkoutConfig(env);
      const upgradeNudge = stores.length && plan === "free"
        ? proUpgradeCard("You're capped at the top 25", "Your other products are invisible to AI agents.", checkout)
        : "";
      return new Response(dashboardPage(session.email, cards.join("\n"), addCta, upgradeNudge, checkout), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (path === "/dashboard/store" && method === "GET") {
      return new Response(storeFormPage("", { name: "", storeUrl: "", consumerKey: "" }, "create", session.email), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (path === "/dashboard/store" && method === "POST") {
      if (!sameOrigin(request)) return new Response("cross-origin form rejected", { status: 403 });
      const stores = await app.listStores(session.userId);
      const plan: PlanKey = stores[0]?.plan ?? "free";
      const limit = plan === "agency" ? 25 : 1;
      if (stores.length >= limit) return new Response(storeFormPage(`Store limit reached on the ${plan} plan.`, { name: "", storeUrl: "", consumerKey: "" }, "create", session.email), { headers: { "content-type": "text/html; charset=utf-8" } });
      return saveStore(request, app, env, session.userId, session.email, null);
    }
    const releaseSetupMatch = /^\/dashboard\/store\/([a-f0-9-]{36})\/release-gate$/.exec(path);
    if (releaseSetupMatch && (method === "GET" || method === "POST")) {
      const store = await app.getStoreForUser(releaseSetupMatch[1], session.userId);
      if (!store) return new Response("not found", { status: 404 });
      if (method === "POST" && !sameOrigin(request)) return new Response("cross-origin form rejected", { status: 403 });
      const [ownershipVerified, evidenceReceived] = await Promise.all([
        app.hasVerifiedReleaseOwnership(store.id, session.userId),
        app.getActivePluginEvidence(store.id, session.userId).then(Boolean),
      ]);
      let bundle;
      let error = "";
      if (method === "POST") {
        if (!env.RELEASE_GATE_OWNERSHIP_SECRET || !env.RELEASE_EVIDENCE_CURRENT_KEY) {
          error = "Connection bundles are temporarily unavailable. Your store settings were not changed.";
        } else {
          bundle = {
            endpoint: (env.PUBLIC_BASE_URL ?? originOf(request)).replace(/\/+$/, ""),
            storeId: store.id,
            ownershipKey: await deriveOwnershipKey(env.RELEASE_GATE_OWNERSHIP_SECRET, store.id),
            evidenceKey: await evidenceKey(env.RELEASE_EVIDENCE_CURRENT_KEY, store.id, "current"),
          };
        }
      }
      return new Response(releaseGateSetupPage({
        store, email: session.email, ownershipVerified, evidenceReceived, bundle, error,
      }), {
        status: error ? 503 : 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const editMatch = /^\/dashboard\/store\/([a-f0-9-]{36})$/.exec(path);
    if (editMatch) {
      const store = await app.getStoreForUser(editMatch[1], session.userId);
      if (!store) return new Response("not found", { status: 404 });
      if (method === "GET") {
        const master = encryptionSecret(env as Record<string, string | undefined>);
        const consumerKey = await decryptSecret(store.wooKeyEnc, master);
        return new Response(storeFormPage("", { id: store.id, name: store.name, storeUrl: store.storeUrl, consumerKey }, "edit", session.email), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (method === "POST") {
        if (!sameOrigin(request)) return new Response("cross-origin form rejected", { status: 403 });
        return saveStore(request, app, env, session.userId, session.email, store);
      }
    }

    if (path === "/dashboard/billing" && method === "GET") {
      const stores = await app.listStores(session.userId);
      // Last-chance retry: a buyer who paid before scanning lands here on
      // their next visit, and this settles the debt without them asking.
      if (stores.length) await settleOwedReportsForStoreUrl(app, env, stores[0].storeUrl);
      const [billingEvents, reports] = await Promise.all([
        app.listBillingEvents(session.userId),
        app.listReportEntitlements(session.userId),
      ]);
      return new Response(
        billingPage(stores[0]?.plan ?? "free", session.email, checkoutConfig(env), billingEvents, reports),
        { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // A purchased report, re-readable in the app. The whole point of storing
    // the HTML: the buyer should never have to find the original email.
    const reportMatch = path.match(/^\/dashboard\/reports\/([0-9a-f-]{36})$/);
    if (reportMatch && method === "GET") {
      const owned = await app.getReportEntitlement(reportMatch[1], session.userId);
      if (!owned?.reportHtml) {
        return new Response("Report not found, or not delivered yet.", { status: 404 });
      }
      return new Response(owned.reportHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // Fired client-side (best-effort) right before Paddle.Checkout.open() —
    // preserves the checkout_started funnel stage now that checkout itself
    // happens in-page via Paddle.js instead of a server-side redirect.
    if (path === "/dashboard/billing/checkout-started" && method === "POST") {
      const body = await request.json().catch(() => null) as { plan?: string } | null;
      const plan = body?.plan === "report" || body?.plan === "pro" || body?.plan === "agency" ? body.plan : null;
      if (plan) {
        const stores = await app.listStores(session.userId);
        await app.recordFunnelEvent({
          kind: "checkout_started", userId: session.userId, storeId: stores[0]?.id ?? null, plan,
        });
      }
      return new Response(null, { status: 204 });
    }

    if (path === "/dashboard/account" && method === "GET") {
      const events = await app.listBillingEvents(session.userId);
      const notice = accountNoticeFromQuery(url);
      const account = await app.getUser(session.userId);
      const hasPassword = account?.passwordHash !== GOOGLE_NO_PASSWORD_HASH;
      return new Response(accountPage(session.email, events, notice, hasPassword), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (path === "/dashboard/account/password" && method === "POST") {
      if (!sameOrigin(request)) return new Response("cross-origin form rejected", { status: 403 });
      const form = await readForm(request);
      const user = await app.getUser(session.userId);
      if (!user) return redirectToAccount("error", "Could not find your account.");
      // A Google-only account has no password to confirm — this route
      // doubles as both "change password" (verify the old one) and "set a
      // password for the first time" (nothing to verify — the session
      // already proved who they are).
      const hasPassword = user.passwordHash !== GOOGLE_NO_PASSWORD_HASH;
      const currentOk = hasPassword ? await verifyPassword(form.get("current_password") ?? "", user.passwordHash) : true;
      if (!currentOk) return redirectToAccount("error", "Current password is wrong.");
      let passwordHash: string;
      try { passwordHash = await hashPassword(form.get("new_password") ?? ""); } catch {
        return redirectToAccount("error", "New password must be 8-200 characters.");
      }
      await app.updateUserPassword(session.userId, passwordHash);
      return redirectToAccount("ok", hasPassword ? "Password updated." : "Password set — you can now log in with email + password too.");
    }
    if (path === "/dashboard/account/email" && method === "POST") {
      if (!sameOrigin(request)) return new Response("cross-origin form rejected", { status: 403 });
      const form = await readForm(request);
      const user = await app.getUser(session.userId);
      if (!user) return redirectToAccount("error", "Could not find your account.");
      const passwordOk = user.passwordHash === GOOGLE_NO_PASSWORD_HASH ? true : await verifyPassword(form.get("email_password") ?? "", user.passwordHash);
      if (!passwordOk) return redirectToAccount("error", "Current password is wrong.");
      const newEmail = (form.get("new_email") ?? "").trim().toLowerCase();
      if (!isValidEmail(newEmail)) return redirectToAccount("error", "Enter a valid email address.");
      if (await app.getUserByEmail(newEmail)) return redirectToAccount("error", "That email is already in use.");
      const changed = await app.updateUserEmail(session.userId, newEmail);
      return redirectToAccount(changed ? "ok" : "error", changed ? "Email updated." : "Could not update email — try again.");
    }
    if (path === "/dashboard/account/delete" && method === "POST") {
      if (!sameOrigin(request)) return new Response("cross-origin form rejected", { status: 403 });
      const form = await readForm(request);
      const user = await app.getUser(session.userId);
      if (!user) return redirectToAccount("error", "Could not find your account.");
      const passwordOk = user.passwordHash === GOOGLE_NO_PASSWORD_HASH ? true : await verifyPassword(form.get("delete_password") ?? "", user.passwordHash);
      if (!passwordOk) return redirectToAccount("error", "Current password is wrong.");
      await app.deleteUser(session.userId);
      return new Response(null, { status: 302, headers: { location: "/login", "set-cookie": clearedSessionCookie() } });
    }
  }

  return null;
}

async function saveStore(
  request: Request, app: AppStore, env: AppEnv,
  userId: string, email: string, existing: StoreRow | null,
): Promise<Response> {
  const form = await readForm(request);
  const name = (form.get("name") ?? "").trim().slice(0, 80);
  const consumerKey = (form.get("consumer_key") ?? "").trim();
  const consumerSecret = (form.get("consumer_secret") ?? "").trim();
  const values = { id: existing?.id, name, storeUrl: form.get("store_url") ?? "", consumerKey };
  const mode = existing ? "edit" : "create";
  let storeUrl: string;
  try { storeUrl = normalizeStoreUrl(form.get("store_url") ?? ""); } catch (error) {
    return new Response(storeFormPage("Store URL must start with https://", values, mode, email), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (!name) return new Response(storeFormPage("Store name is required.", values, mode, email), { headers: { "content-type": "text/html; charset=utf-8" } });
  if (!/^ck_/.test(consumerKey)) {
    return new Response(storeFormPage("Consumer key looks wrong — it should start with ck_. Copy it from WooCommerce → Settings → Advanced → REST API.", values, mode, email), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  // On create the secret is mandatory; on edit an empty secret means "keep
  // the one already on file" (it's never echoed back to the form, so
  // requiring it on every save would force re-entry just to fix a typo in
  // the name or URL) — but a NON-empty value on edit still has to look
  // like a real secret, not silently accept garbage.
  if (!existing && !/^cs_/.test(consumerSecret)) {
    return new Response(storeFormPage("Consumer secret looks wrong — it should start with cs_. Copy it from WooCommerce → Settings → Advanced → REST API.", values, mode, email), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (existing && consumerSecret && !/^cs_/.test(consumerSecret)) {
    return new Response(storeFormPage("Consumer secret looks wrong — it should start with cs_, or leave it blank to keep the current one.", values, mode, email), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  const master = encryptionSecret(env as Record<string, string | undefined>);
  const keyEnc = await encryptSecret(consumerKey, master);
  if (existing) {
    const secretEnc = consumerSecret ? await encryptSecret(consumerSecret, master) : existing.wooSecretEnc;
    await app.updateStoreCredentials(existing.id, userId, name, storeUrl, keyEnc, secretEnc);
    return new Response(null, { status: 302, headers: { location: "/dashboard" } });
  }
  const secretEnc = await encryptSecret(consumerSecret, master);
  const id = crypto.randomUUID();
  const created = await app.createStore({
    id, userId, name, storeUrl, wooKeyEnc: keyEnc, wooSecretEnc: secretEnc,
    plan: "free", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
  });
  if (!created) return new Response(storeFormPage("Could not save the store — try again.", values, "create", email), { headers: { "content-type": "text/html; charset=utf-8" } });
  return new Response(null, { status: 302, headers: { location: "/dashboard" } });
}
