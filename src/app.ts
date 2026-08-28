// Merchant app routes: accounts, stores, scan, dashboard, billing, Paddle
// webhooks, and the per-store agent surface (/feed/{id}, /mcp/{id}).
// Returns null for unhandled paths so index.ts can fall through to the
// legacy env-configured endpoints.
import { AppStore, offerLimitFor, type PlanKey, type StoreRow } from "./core/appStore.ts";
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
  adminUsersPage, adminUserDetailPage, proUpgradeCard,
} from "./web.ts";
import { handlePaddleWebhook, type PaddleEnv } from "./webhooks.ts";
import { TOOL_NAME } from "./mcp.ts";
import { sendEmail, passwordResetEmailHtml } from "./core/email.ts";
import type { RevenueGuard } from "./core/guard.ts";
import type { ServiceConfig } from "./service.ts";

export interface AppEnv {
  FINANCIAL_DB?: unknown;
  APP_ENCRYPTION_SECRET?: string;
  CART_SIGNING_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  PADDLE_WEBHOOK_SECRET?: string;
  PADDLE_PRICE_REPORT?: string;
  PADDLE_PRICE_PRO?: string;
  PADDLE_PRICE_AGENCY?: string;
  OPS_TOKEN?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  ADMIN_PASSWORD?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  OPENAI_API_KEY?: string;
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

function paddleLinks(env: AppEnv): { report?: string; pro?: string; agency?: string } {
  return {
    report: env.PADDLE_PRICE_REPORT ? `https://pay.paddle.com/checkout/${env.PADDLE_PRICE_REPORT}` : undefined,
    pro: env.PADDLE_PRICE_PRO ? `https://pay.paddle.com/checkout/${env.PADDLE_PRICE_PRO}` : undefined,
    agency: env.PADDLE_PRICE_AGENCY ? `https://pay.paddle.com/checkout/${env.PADDLE_PRICE_AGENCY}` : undefined,
  };
}

async function storeAgentHits(env: AppEnv, storeId: string): Promise<number> {
  const db = env.FINANCIAL_DB as ConstructorParameters<typeof AppStore>[0] | undefined;
  if (!db) return 0;
  const financial = new (await import("./core/d1Store.ts")).D1FinancialStore(db);
  try {
    return await financial.countRequests(PRODUCT_ID, "store", storeId, Date.now() - 30 * 86_400_000);
  } catch { return 0; }
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
    return new Response(JSON.stringify({ since_days: days, funnel }, null, 1), { headers: { "content-type": "application/json" } });
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
      await app.saveScan({ id, storeUrl, score: result.score, resultJson: JSON.stringify(result), createdAt: Date.now() });
      await app.recordFunnelEvent({ kind: "scan_completed", meta: { store_url: storeUrl, score: result.score, via: "api" } });
    }
    return new Response(JSON.stringify({ ...result, id: id || undefined }), { headers: { "content-type": "application/json" } });
  }
  if (path === "/scan" && method === "POST") {
    const ip = request.headers.get("cf-connecting-ip") ?? "local";
    if (!scanAllowed(ip)) {
      return new Response(scanFormPage(), { status: 429, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const form = await readForm(request);
    let storeUrl = "";
    try { storeUrl = normalizeStoreUrl(form.get("store_url") ?? ""); } catch (error) {
      return new Response(scanFormPage(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const result = await scanStore(storeUrl, fetch);
    let id = "";
    if (app) {
      id = crypto.randomUUID();
      await app.saveScan({ id, storeUrl, score: result.score, resultJson: JSON.stringify(result), createdAt: Date.now() });
      await app.recordFunnelEvent({ kind: "scan_completed", meta: { store_url: storeUrl, score: result.score, via: "form" } });
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
      note: limited.truncated ? "Free plan shows the top 10 products — upgrade for unlimited offers." : undefined,
    }, null, 1), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" } });
  }
  // Per-store commerce tool surface (search/offer/cart-link for one
  // merchant's own catalog): gated by the store's Paddle plan, the same
  // top-10 free-tier limit /feed already enforces — NOT by the x402
  // per-call payment rail. That rail belongs to a different product (the
  // global readiness-scan tool at POST /mcp, index.ts); a merchant who
  // paid via Paddle for "unlimited offers, signed cart handoff" expects
  // agents to actually be able to call this, not hit an unrelated wall.
  if (path.startsWith("/mcp/") && method === "POST" && app) {
    const store = await app.getStore(path.slice("/mcp/".length));
    if (!store || store.status !== "active") return new Response(JSON.stringify({ error: "store not found" }), { status: 404, headers: { "content-type": "application/json" } });
    const { config } = await storeServiceConfig(store, env as Record<string, string | undefined>, originOf(request));
    const body = await request.json() as { tool: string; input: Record<string, unknown> };
    if (body.tool !== TOOL_NAME) {
      return new Response(JSON.stringify({ error: `unknown tool: ${body.tool}` }), { status: 400, headers: { "content-type": "application/json" } });
    }
    const { runTool } = await import("./service.ts");
    const action = typeof body.input?.action === "string" ? body.input.action : "";
    try {
      if (action === "get_feed" || action === "search_products") {
        const result = await runTool(body.input, config);
        const offers = Array.isArray(result.offers) ? result.offers as Array<Record<string, unknown>> : [];
        const limited = applyOfferLimit(offers, store.plan);
        return new Response(JSON.stringify({ result: { ...result, offers: limited.offers, truncated: limited.truncated } }), { headers: { "content-type": "application/json" } });
      }
      if (action === "get_offer" || action === "create_cart_link") {
        const limit = offerLimitFor(store.plan);
        if (limit >= 0) {
          const productId = Number(body.input.product_id);
          const feed = await runTool({ action: "get_feed" }, config);
          const visibleIds = (Array.isArray(feed.offers) ? feed.offers as Array<{ id?: unknown }> : [])
            .slice(0, limit).map((o) => Number(o.id));
          if (!visibleIds.includes(productId)) {
            return new Response(JSON.stringify({ error: "this product is outside the free plan's visible catalog — upgrade for unlimited offers" }), { status: 403, headers: { "content-type": "application/json" } });
          }
        }
      }
      const result = await runTool(body.input, config);
      return new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } });
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
      // Only a connected, free-plan store has actually hit the 10-product
      // cap — a brand-new account with zero stores hasn't earned this pitch
      // yet, and a Pro/Agency account shouldn't see its own upgrade offer.
      const upgradeNudge = stores.length && plan === "free"
        ? proUpgradeCard("You're capped at the top 10", "Your other products are invisible to AI agents.", paddleLinks(env).pro)
        : "";
      return new Response(dashboardPage(session.email, cards.join("\n"), addCta, upgradeNudge), { headers: { "content-type": "text/html; charset=utf-8" } });
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
      const links = paddleLinks(env);
      const trackedLinks = {
        report: links.report ? "/dashboard/billing/checkout/report" : undefined,
        pro: links.pro ? "/dashboard/billing/checkout/pro" : undefined,
        agency: links.agency ? "/dashboard/billing/checkout/agency" : undefined,
      };
      return new Response(billingPage(stores[0]?.plan ?? "free", session.email, trackedLinks), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    const checkoutMatch = /^\/dashboard\/billing\/checkout\/(report|pro|agency)$/.exec(path);
    if (checkoutMatch && method === "GET") {
      const target = checkoutMatch[1] as "report" | "pro" | "agency";
      const links = paddleLinks(env);
      const destination = links[target];
      if (!destination) return new Response("checkout not configured", { status: 404 });
      const stores = await app.listStores(session.userId);
      await app.recordFunnelEvent({
        kind: "checkout_started", userId: session.userId, storeId: stores[0]?.id ?? null, plan: target,
      });
      return new Response(null, { status: 302, headers: { location: destination } });
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
