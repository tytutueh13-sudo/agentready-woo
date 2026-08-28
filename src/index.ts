// Cloudflare Worker entrypoint. Cloudflare-specific glue only — all business
// logic lives in service.ts/mcp.ts/api.ts, none of which import from
// "cloudflare:workers" (section 24: keep platform code and business logic separate).
import { health, status } from "./health.ts";
import { D1FinancialStore, type D1DatabaseLike } from "./core/d1Store.ts";
import { RevenueGuard } from "./core/guard.ts";
import { X402PaymentProvider } from "./core/paymentProvider.ts";
import type { RevenueGuardConfig } from "./core/pricing.ts";
import { handleMcpCall, TOOL_NAME } from "./mcp.ts";
import { handleApiCall, API_PATH } from "./api.ts";
import { handleAppRequest, type AppEnv } from "./app.ts";
import { buildAgenticWebMd, configFromEnv, configureService } from "./service.ts";
import { AppStore } from "./core/appStore.ts";
import { pingIndexNow } from "./core/indexnow.ts";
import { sendEmail, weeklyDigestEmailHtml } from "./core/email.ts";

const PRODUCT_ID = "early-3426536d88daa242";
const PRICE_PER_CALL = 0.05;

// Section 37: bound request size before parsing the body. maxInputSizeBytes
// comes from ProductSpec.security_policy — see product.json.
const MAX_INPUT_SIZE_BYTES = 65536;

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

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
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
    const paymentProvider = new X402PaymentProvider(env);
    const guard = new RevenueGuard(
      store, REVENUE_GUARD_CONFIG, paymentProvider,
      env as unknown as Record<string, string | undefined>,
    );
    configureService(env as unknown as Record<string, string | undefined>);

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
      return new Response(JSON.stringify(health(PRODUCT_ID, "1.0.0",
        env as unknown as Record<string, string | undefined>)), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.pathname === "/status") {
      return new Response(JSON.stringify(status(
        PRODUCT_ID, "1.0.0",
        env as unknown as Record<string, string | undefined>,
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
<p>Makes self-hosted WooCommerce stores readable and buyable by AI shopping agents. Checkout always completes on the merchant's own store.</p>
<p><a class="btn" href="/scan">Check your store — free</a></p>
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
    if (url.pathname === "/mcp" && request.method === "POST") {
      const tooLarge = rejectIfTooLarge(request);
      if (tooLarge) return tooLarge;
      const body = (await request.json()) as { tool: string; input: Record<string, unknown>; requestId?:string };
      body.requestId=request.headers.get("Idempotency-Key")??body.requestId;
      const paymentReference = await registerPaymentProof(request, (body as { paymentReference?: string }).paymentReference, paymentProvider);
      (body as { paymentReference?: string }).paymentReference = paymentReference;
      const result = await handleMcpCall(guard, body, PRICE_PER_CALL, PRODUCT_ID);
      const httpStatus = result.stage === "payment" ? 402 : result.stage === "auth" ? 401 : result.error ? 400 : 200;
      const { _paymentResponse, ...publicResult }=result;const headers:Record<string,string>={"content-type":"application/json"};
      if(httpStatus===402&&result.x402Version===2)headers["PAYMENT-REQUIRED"]=encodeX402Header(paymentRequired(request.url,result.error??"payment required",result.accepts??[]));
      if(_paymentResponse)headers["PAYMENT-RESPONSE"]=encodeX402Header(_paymentResponse);
      return new Response(JSON.stringify(publicResult), { status:httpStatus, headers });
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

    return new Response("not found", { status: 404 });
  },
  async scheduled(_controller: ScheduledController, env: WorkerEnv,
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
      // H-01: each phase is independent. A failure in one must not skip the
      // rest of the sweep — in particular it must not skip the purge, or
      // expired escrow payloads and payment proofs would be retained.
      const phases: [string, () => Promise<unknown>][] = [
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
        // Not financial housekeeping — piggybacks on the same 5-minute
        // trigger since Cloudflare cron only supports one schedule per
        // trigger string here, and usersDueForDigest already makes this
        // safe to check every 5 minutes without double-sending.
        ["send_weekly_digests", () => sendWeeklyDigests(store, new AppStore(env.FINANCIAL_DB!), env)],
        // Also piggybacks on the 5-minute trigger, self-paced to once a day
        // by only running in the first tick of hour 3 UTC — IndexNow has no
        // per-URL rate limit that matters at this site's size, but there's
        // no reason to hit it every 5 minutes when the sitemap rarely changes.
        ["ping_indexnow", () => {
          const now = new Date();
          if (now.getUTCHours() !== 3 || now.getUTCMinutes() >= 5) return Promise.resolve();
          return pingIndexNow((env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, ""));
        }],
      ];
      for (const [name, run] of phases) {
        try { await run(); }
        catch (error) { console.error(`scheduled phase failed: ${name}`, error); }
      }
    })());
  },
};
