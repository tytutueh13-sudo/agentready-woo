// Cloudflare Worker entrypoint. Cloudflare-specific glue only — all business
// logic lives in service.ts/mcp.ts/api.ts, none of which import from
// "cloudflare:workers" (section 24: keep platform code and business logic separate).
import { health, status } from "./health.ts";
import { D1FinancialStore, type D1DatabaseLike } from "./core/d1Store.ts";
import { RevenueGuard } from "./core/guard.ts";
import { X402PaymentProvider } from "./core/paymentProvider.ts";
import type { RevenueGuardConfig } from "./core/pricing.ts";
import { handleMcpCall, TOOL_NAME } from "./mcp.ts";
import { handleJsonRpc, isJsonRpc } from "./core/mcpRpc.ts";
import { handleApiCall, API_PATH } from "./api.ts";
import { serviceErrorPage } from "./web.ts";
import {
  PUBLIC_SCAN_TOOL_DESCRIPTION, PUBLIC_SCAN_TOOL_NAME, publicScanMcpTool,
} from "./publicScanMcp.ts";
import { handleAppRequest, type AppEnv } from "./app.ts";
import { buildAgenticWebMd, configFromEnv, configureService } from "./service.ts";
import { AppStore } from "./core/appStore.ts";
import { pingIndexNow } from "./core/indexnow.ts";
import { sendEmail, weeklyDigestEmailHtml } from "./core/email.ts";
import type { WorkersAiBinding } from "./core/aiJudge.ts";
import { releaseGateMcpTools } from "./releaseGate/mcpTools.ts";
import type { McpTool } from "./core/mcpRpc.ts";
import {
  classifyToolResult, mcpChannelForPath, operatorMcpAuthorized, usageChannel,
  type UsageChannel, type UsageOutcome,
} from "./core/usage.ts";
import {
  AGENTREADY_PUBLIC_NAME, AGENTREADY_SERVER_NAME, AGENTREADY_VERSION,
} from "./productIdentity.ts";
export { ReleaseGateAcceptanceWorkflow } from "./workflows/releaseGateWorkflow.ts";

const PRODUCT_ID = "early-3426536d88daa242";
// Public identity must never expose the durable internal product key used by
// legacy D1 counters and financial-guard records.
const PUBLIC_SERVICE_NAME = AGENTREADY_PUBLIC_NAME;
/** The global readiness-scan tool, over MCP and over the REST shape alike.
 *
 * Zero, and that is the product working rather than a concession. The scan is
 * how a merchant discovers they are not agent-ready — the homepage offers it
 * free, and the paid tiers are what comes after. Charging for it over MCP
 * meant the site and the code disagreed about the same thing.
 *
 * It was priced at $0.05 settled through x402 on `eip155:84532` — Base
 * Sepolia. No agent holds testnet USDC, so every agent that found this tool
 * was answered 402 against a currency it could not obtain: not a paywall, a
 * closed door with a price list on it. Measured in production before this
 * changed.
 *
 * The x402 rail stays wired and tested. Pointing it at a network where
 * settlement is real is a configuration change, and the paid tiers of the
 * per-store surface are gated by Paddle, which is where money actually
 * arrives today.
 */
const PRICE_PER_CALL = 0;

/** IndexNow's own trigger, so nothing has to pick a tick by reading the clock. */
const DAILY_CRON = "0 3 * * *";

// Section 37: bound request size before parsing the body. maxInputSizeBytes
// comes from ProductSpec.security_policy — see product.json.
const MAX_INPUT_SIZE_BYTES = 65536;

// Public ownership proof for the Glama directory. Glama requires this exact
// document to remain available on the connector origin after verification.
// It is deliberately served before the D1 readiness gate: directory
// ownership must not disappear during an unrelated database incident.
const GLAMA_CLAIM_DOCUMENT = {
  $schema: "https://glama.ai/mcp/schemas/connector.json",
  claim: "glama_claim_SURSLzr6kHLvRUDDcPcTzQp_7C7b_G5H",
} as const;

function rejectIfTooLarge(request: Request): Response | null {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_INPUT_SIZE_BYTES) {
    return new Response(JSON.stringify({ error: "request body too large" }), {
      status: 413, headers: { "content-type": "application/json" },
    });
  }
  return null;
}

export function encodeX402Header(value:unknown):string{const bytes=new TextEncoder().encode(JSON.stringify(value));let binary="";for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary);}
export function paymentRequired(url:string,error:string,accepts:unknown[]):unknown{return{x402Version:2,error,resource:{url,description:PRODUCT_ID,mimeType:"application/json"},accepts};}

const REVENUE_GUARD_CONFIG: RevenueGuardConfig = {
  minGrossMarginRatio: 0.7,
  minPriceMultiplier: 3.0,
  perRequestMaxCost: 0.5,
  dailyMaxCost: 5.0,
  monthlyMaxCost: 300.0,
  perUserDailyCost: 2.0,
  perProductDailyCost: 20.0,
  rateLimitWindowSeconds: 60.0,
  rateLimitMaxRequests: 30,
  circuitBreakerFailureThreshold: 5,
  circuitBreakerWindowSeconds: 60,
  circuitBreakerCooldownSeconds: 60,
  cacheDefaultTtlSeconds: 3600.0,
};

interface WorkerEnv {
  FINANCIAL_DB?: D1DatabaseLike;
  REVENUE_SYSTEM_ENABLED?: string; REAL_PAYMENTS_ENABLED?: string;
  X402_FACILITATOR_URL?: string; X402_PAY_TO?: string; X402_ASSET?: string;
  X402_NETWORK?: string;
  MONEYAI_ARTIFACT_HASH?: string; MONEYAI_PAYMENT_MODE?: string;
  D1_REAL_CONCURRENCY_VERIFIED?: string; X402_WIRE_INTEROP_VERIFIED?: string;
  WOO_STORE_URL?: string; WOO_CONSUMER_KEY?: string; WOO_CONSUMER_SECRET?: string;
  CART_SIGNING_SECRET?: string; PUBLIC_BASE_URL?: string;
  APP_ENCRYPTION_SECRET?: string;
  PADDLE_WEBHOOK_SECRET?: string;
  PADDLE_PRICE_REPORT?: string; PADDLE_PRICE_PRO?: string; PADDLE_PRICE_AGENCY?: string;
  RESEND_API_KEY?: string; EMAIL_FROM?: string;
  RELEASE_GATE_OWNERSHIP_SECRET?: string;
  OPS_TOKEN?: string;
  CF_VERSION_METADATA?: { id?: string; tag?: string; timestamp?: string };
  RELEASE_GATE_WORKFLOW?: { create(input: { params: { runId: string } }): Promise<unknown> };
  AI?: WorkersAiBinding;
}

/** One weekly email per user with a store connected, showing real agent-
 * request counts (including zero) over the last 7 days. "Due" users are
 * found via AppStore.usersDueForDigest, which self-paces to ~weekly without
 * needing the cron trigger itself to understand days of the week — see its
 * doc comment. Failure for one user must not block the rest. */
async function sendWeeklyDigests(financial: D1FinancialStore, appStore: AppStore, env: WorkerEnv): Promise<void> {
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const dashboardUrl = `${(env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "")}/dashboard`;
  const due = await appStore.usersDueForDigest(now - sevenDaysMs, 25);
  for (const user of due) {
    try {
      const stores = await appStore.listStores(user.id);
      const rows = await Promise.all(stores.map(async s => ({
        name: s.name, storeUrl: s.storeUrl,
        hits: await financial.countRequests(PRODUCT_ID, "store", s.id, now - sevenDaysMs),
      })));
      await sendEmail(env, user.email, "Your week on AgentReady", weeklyDigestEmailHtml(rows, dashboardUrl));
      await appStore.markDigestSent(user.id, now);
    } catch (error) {
      console.error("weekly digest failed for user", { userId: user.id, error: String(error) });
    }
  }
}

async function registerPaymentProof(request: Request, reference: string | undefined,
  provider: X402PaymentProvider): Promise<string | undefined> {
  const encoded = request.headers.get("PAYMENT-SIGNATURE");
  if (!encoded) return reference;
  try {
    const normalized=encoded.replace(/-/g,"+").replace(/_/g,"/");
    const padded=normalized+"=".repeat((4-normalized.length%4)%4);
    const json=encoded.trim().startsWith("{")?encoded:atob(padded);
    const paymentPayload:unknown=JSON.parse(json);
    if(!paymentPayload||typeof paymentPayload!=="object"||Array.isArray(paymentPayload))return reference;
    if(!reference){const bytes=new TextEncoder().encode(encoded);reference=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(v=>v.toString(16).padStart(2,"0")).join("");}
    provider.registerPayment(reference,paymentPayload);
    return reference;
  } catch { return reference; /* malformed proof is rejected by authorization */ }
}

async function recordPublicScanOutcome(
  appStore: AppStore, outcome: "success" | "refused" | "invalid",
): Promise<void> {
  try {
    await appStore.recordPublicMcpCall(PUBLIC_SCAN_TOOL_NAME, outcome);
  } catch (error) {
    // Telemetry must never turn a free, read-only scan into a failed call.
    console.error("public MCP usage aggregation failed", { error: String(error) });
  }
}

async function recordSurfaceOutcome(
  appStore: AppStore, operation: string, channel: UsageChannel, outcome: UsageOutcome,
): Promise<void> {
  try {
    await appStore.recordSurfaceUsage("mcp", operation, channel, outcome);
  } catch (error) {
    // A measurement outage must not turn a product result into an outage.
    console.error("aggregate surface usage write failed", { operation, channel, outcome, error: String(error) });
  }
}

function instrumentedMcpTool(appStore: AppStore, tool: McpTool, channel: UsageChannel): McpTool {
  return {
    ...tool,
    async run(args, context) {
      try {
        const result = await tool.run(args, context);
        const outcome = classifyToolResult(result.ok, result.text);
        await recordSurfaceOutcome(appStore, tool.name, channel, outcome);
        if (tool.name === PUBLIC_SCAN_TOOL_NAME) {
          await recordPublicScanOutcome(appStore,
            outcome === "answered" ? "success" : outcome === "invalid" ? "invalid" : "refused");
        }
        return result;
      } catch (error) {
        await recordSurfaceOutcome(appStore, tool.name, channel, "internal_error");
        throw error;
      }
    },
  };
}

/** Sent with every response this Worker writes.
 *
 * `public/_headers` MUST stay identical: Cloudflare serves a matching static
 * asset directly and never invokes this Worker, so a wrapper here covers its
 * own routes and nothing else. A difference between the two would mean a
 * page's protection depended on which half answered it.
 *
 * The payment allowances are Paddle's, because that is the only third party
 * this app hands a buyer to.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "permissions-policy": "geolocation=(), microphone=(), camera=(), payment=(self \"https://checkout.paddle.com\")",
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.paddle.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self'",
    "connect-src 'self' https://cdn.paddle.com https://checkout.paddle.com",
    "frame-src https://checkout.paddle.com https://buy.paddle.com",
    "form-action 'self' https://accounts.google.com",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join("; "),
};

/** Applied without overwriting: a route that has already decided on a
 * narrower value for itself knows something this does not. */
export function secured(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // Every exit below goes through one wrapper. There are a dozen returns in
    // this handler and each one would otherwise be a place to forget.
    try {
      return secured(await route(request, env));
    } catch (error) {
      // An unhandled throw used to reach the merchant as Cloudflare's own
      // error page, which reads as "your store broke us". Say whose fault it
      // is, in the product's own voice, and keep the API contract for
      // non-browser callers.
      console.error("unhandled request failure", { url: request.url, error: String(error) });
      return secured(wantsHtml(request)
        ? new Response(serviceErrorPage("upstream"), {
            status: 500, headers: { "content-type": "text/html; charset=utf-8" } })
        : new Response(JSON.stringify({ error: "internal error" }), {
            status: 500, headers: { "content-type": "application/json" } }));
    }
  },
  async scheduled(controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    return scheduledRun(controller, env, ctx);
  },
};

/** Everything the Worker answers, before the security headers go on. */
async function route(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/glama.json" && request.method === "GET") {
      return new Response(JSON.stringify(GLAMA_CLAIM_DOCUMENT), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    }
    if (!env.FINANCIAL_DB) {
      return new Response(JSON.stringify({ error: "durable financial store is not configured" }), {
        status: 503, headers: { "content-type": "application/json" },
      });
    }
    const store = new D1FinancialStore(env.FINANCIAL_DB);
    try {
      // Version/checksum/schema drift is a startup-readiness failure.  Do
      // this before health or any request path can report the Worker ready.
      await store.ensureSchema();
    } catch {
      return new Response(JSON.stringify({ error: "financial schema is not ready" }), {
        status: 503, headers: { "content-type": "application/json" },
      });
    }
    // The AI budget ledger belongs to the merchant app schema, not the
    // financial ledger above. Initializing it on the two readiness routes
    // makes a green health check truthful and gives the aggregate-only
    // operations guard a zero row to query before the first paid packet.
    if (url.pathname === "/health" || url.pathname === "/status") {
      try {
        await new AppStore(env.FINANCIAL_DB).ensureSchema();
      } catch {
        return new Response(JSON.stringify({ error: "application schema is not ready" }), {
          status: 503, headers: { "content-type": "application/json" },
        });
      }
    }
    const paymentProvider = new X402PaymentProvider(env);
    const guard = new RevenueGuard(
      store, REVENUE_GUARD_CONFIG, paymentProvider,
      env as unknown as Record<string, string | undefined>,
    );
    configureService(env as unknown as Record<string, string | undefined>);
    const appStore = new AppStore(env.FINANCIAL_DB);

    // Merchant app (accounts, stores, scan, dashboard, webhooks, per-store
    // agent surface). Returns null when the path is not an app route.
    const appResponse = await handleAppRequest(request, env, url, guard);
    if (appResponse) return appResponse;

    if (url.pathname === "/.well-known/agenticweb.md" && request.method === "GET") {
      const markdown = buildAgenticWebMd(configFromEnv(env as unknown as Record<string, string | undefined>));
      return new Response(markdown, {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }

    if (url.pathname === "/health") {
      return new Response(JSON.stringify(health(PUBLIC_SERVICE_NAME, AGENTREADY_VERSION,
        env as unknown as Record<string, string | undefined>)), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/status") {
      return new Response(JSON.stringify(status(
        PUBLIC_SERVICE_NAME, AGENTREADY_VERSION,
        env as unknown as Record<string, string | undefined>, PRODUCT_ID,
      )), {
        headers: { "content-type": "application/json" },
      });
    }

    if (url.pathname === "/") {
      const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentReady Woo</title>
<style>
:root{--paper:#FAF9F5;--ink:#17151C;--ink2:#55515E;--line:#E5E2DB;--acc:#E4572E}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--paper);color:var(--ink);font-family:'Spline Sans',system-ui,sans-serif;line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:640px;margin:0 auto;padding:64px 24px}
h1{font-family:Georgia,serif;font-weight:500;font-size:32px;letter-spacing:-.01em;margin-bottom:8px}
p{color:var(--ink2);margin-bottom:18px}
.btn{display:inline-block;background:var(--acc);color:#fff;font-weight:600;border-radius:6px;padding:12px 24px;text-decoration:none}
.btn:hover{background:#C43F1B}
.links{margin-top:28px;font-size:14px}
.links a{color:var(--ink2);margin-right:18px}
</style>
</head>
<body>
<div class="wrap">
<h1><em>AgentReady</em> / Woo</h1>
<p>Run a passive WooCommerce preflight, then make an owner-authorized release decision from signed aggregate evidence. No order or payment is created.</p>
<p><a class="btn" href="/scan">Run the public preflight — free</a></p>
<div class="links">
<a href="/signup">Merchant login</a>
<a href="/health">Health</a>
<a href="/.well-known/agenticweb.md">Discovery</a>
</div>
</div>
</body>
</html>
`;
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const attributedMcpChannel = mcpChannelForPath(url.pathname);
    const operatorMcp = url.pathname === "/ops/mcp";
    if (operatorMcp && !operatorMcpAuthorized(request, env.OPS_TOKEN)) {
      return new Response(JSON.stringify({ error: "operator authorization required" }), {
        status: env.OPS_TOKEN && env.OPS_TOKEN.length >= 32 ? 401 : 503,
        headers: { "content-type": "application/json" },
      });
    }
    if ((url.pathname === "/mcp" || attributedMcpChannel !== null || operatorMcp) && request.method === "POST") {
      const tooLarge = rejectIfTooLarge(request);
      if (tooLarge) return tooLarge;
      const raw = (await request.json()) as unknown;

      // The root is the public, credential-free readiness scan. Store-bound
      // catalogue and cart tools remain at /mcp/{store_id}; publishing those
      // without a real tenant would advertise a tool no caller can use.
      if (isJsonRpc(raw)) {
        const channel = operatorMcp
          ? "operator"
          : usageChannel(request, env.OPS_TOKEN, attributedMcpChannel ?? "direct");
        const tools = [
          publicScanMcpTool(),
          ...releaseGateMcpTools({}, { app: appStore, workflow: env.RELEASE_GATE_WORKFLOW }),
        ].map(tool => instrumentedMcpTool(appStore, tool, channel));
        const reply = await handleJsonRpc(raw, {
          // A name a person reads in a registry listing, not the internal
          // product id — that reported itself as "early-3426536d88daa242".
          name: AGENTREADY_SERVER_NAME, version: AGENTREADY_VERSION,
          instructions: "Run a privacy-safe readiness scan against a public WooCommerce storefront. Store-bound shopping tools use /mcp/{store_id}.",
        }, tools, {
          authorization: operatorMcp ? undefined : request.headers.get("authorization") ?? undefined,
        });

        if (reply === null) return new Response(null, { status: 202 });
        return new Response(JSON.stringify(reply), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      const body = raw as { tool?: string; input?: Record<string, unknown> };
      if (body.tool !== PUBLIC_SCAN_TOOL_NAME) {
        await recordPublicScanOutcome(appStore, "invalid");
        await recordSurfaceOutcome(appStore, "legacy_public_scan", operatorMcp ? "operator" : usageChannel(
          request, env.OPS_TOKEN, attributedMcpChannel ?? "direct"), "invalid");
        return new Response(JSON.stringify({ error: `unknown tool: ${String(body.tool ?? "(missing)")}` }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      }
      const out = await publicScanMcpTool().run(body.input ?? {});
      await recordPublicScanOutcome(appStore, out.ok ? "success" : "refused");
      await recordSurfaceOutcome(appStore, "legacy_public_scan", operatorMcp ? "operator" : usageChannel(
        request, env.OPS_TOKEN, attributedMcpChannel ?? "direct"), classifyToolResult(out.ok, out.text));
      return new Response(out.text, {
        status: out.ok ? 200 : 400, headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === API_PATH && request.method === "POST") {
      const tooLarge = rejectIfTooLarge(request);
      if (tooLarge) return tooLarge;
      const body = (await request.json()) as { input: Record<string, unknown>; requestId?:string };
      body.requestId=request.headers.get("Idempotency-Key")??body.requestId;
      const paymentReference = await registerPaymentProof(request, (body as { paymentReference?: string }).paymentReference, paymentProvider);
      (body as { paymentReference?: string }).paymentReference = paymentReference;
      const { status: httpStatus, body: responseBody, paymentResponse } = await handleApiCall(guard, body, PRICE_PER_CALL, PRODUCT_ID);
      const headers:Record<string,string>={"content-type":"application/json"};
      if(httpStatus===402&&responseBody&&typeof responseBody==="object"&&"accepts" in responseBody)headers["PAYMENT-REQUIRED"]=encodeX402Header(paymentRequired(request.url,String((responseBody as {error?:unknown}).error??"payment required"),(responseBody as {accepts:unknown[]}).accepts));
      if(paymentResponse)headers["PAYMENT-RESPONSE"]=encodeX402Header(paymentResponse);
      return new Response(JSON.stringify(responseBody), {
        status: httpStatus, headers,
      });
    }

    return wantsHtml(request)
      ? new Response(serviceErrorPage("not_found"), {
          status: 404, headers: { "content-type": "text/html; charset=utf-8" } })
      : new Response("not found", { status: 404 });
}

/** A browser asks for HTML; curl, an agent and an MCP client do not. Only the
 * former gets a page — an API caller that started receiving HTML on a 404
 * would be a contract change. */
function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

async function scheduledRun(controller: ScheduledController, env: WorkerEnv,
    ctx: ExecutionContext): Promise<void> {
    if (!env.FINANCIAL_DB) return;
    const store = new D1FinancialStore(env.FINANCIAL_DB);
    try { await store.ensureSchema(); } catch (error) {
      console.error("scheduled financial schema is not ready", error);
      return;
    }
    const provider = new X402PaymentProvider(env);
    const guard = new RevenueGuard(
      store, REVENUE_GUARD_CONFIG, provider,
      env as unknown as Record<string, string | undefined>,
    );
    ctx.waitUntil((async () => {
      // Which trigger fired decides what runs. A phase that reads the clock
      // to decide for itself is a second schedule hiding inside the first,
      // and that is how the daily ping used to disappear: it required
      // `hour === 3 && minute < 5`, so an invocation that started a few
      // minutes late threw the whole day away in silence. The identical
      // guard cost WP Update Radar entire sweeps before it was found.
      const frequent: [string, () => Promise<unknown>][] = [
        // Only pre-upstream reservations can expire automatically. Existing
        // settlement obligations remain recoverable even while kill is active.
        ["expire_safe_reservations", () => store.recoverExpiredSafeReservations(Date.now() - 15 * 60 * 1000)],
        ["recover_pending", () => guard.recoverPending(50)],
        // H-02: ledger conservation is checked on a schedule, not only at
        // release, so a mismatch introduced after the fact still halts the
        // product before the next paid request.
        ["reconcile_pending", () => guard.reconcilePending(50)],
        // Released result payloads and expired payment proofs are physically
        // removed only after recovery has had a chance to inspect obligations.
        ["purge_expired", () => store.purgeExpiredSensitiveData(Date.now())],
        // Safe on every tick: usersDueForDigest is what stops a double-send,
        // not the schedule.
        ["send_weekly_digests", () => sendWeeklyDigests(store, new AppStore(env.FINANCIAL_DB!), env)],
      ];
      const daily: [string, () => Promise<unknown>][] = [
        // IndexNow has no per-URL rate limit that matters at this site's
        // size, but there is no reason to hit it every five minutes when the
        // sitemap rarely changes — and no reason to pick the moment by hand
        // when a cron expression can.
        ["ping_indexnow", () => pingIndexNow((env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, ""))],
      ];
      // H-01: each phase is independent. A failure in one must not skip the
      // rest of the sweep — in particular it must not skip the purge, or
      // expired escrow payloads and payment proofs would be retained.
      const phases = controller.cron === DAILY_CRON ? daily : frequent;
      for (const [name, run] of phases) {
        try { await run(); }
        catch (error) { console.error(`scheduled phase failed: ${name}`, error); }
      }
    })());
  }
