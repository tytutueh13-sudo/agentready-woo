// Paddle Billing webhook: verify signature, map price -> plan, activate.
// Paddle signs webhooks with HMAC-SHA256 over "ts:rawBody" using the
// webhook secret; the signature arrives as "Paddle-Signature: ts=..;h1=..".
import { AppStore, type PlanKey } from "./core/appStore.ts";
import { sendEmail, deepReportEmailHtml, type DeepReportScan } from "./core/email.ts";
import { judgeReadiness } from "./core/aiJudge.ts";
import type { ScanResult } from "./core/scan.ts";

export interface PaddleEnv {
  PADDLE_WEBHOOK_SECRET?: string;
  PADDLE_PRICE_REPORT?: string;
  PADDLE_PRICE_PRO?: string;
  PADDLE_PRICE_AGENCY?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  OPENAI_API_KEY?: string;
}

async function hmacSha256(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map(v => v.toString(16).padStart(2, "0")).join("");
}

export function parsePaddleSignature(header: string): { ts: string; h1: string } | null {
  const parts = Object.fromEntries(header.split(";").map(p => p.trim().split("=") as [string, string]));
  if (!parts.ts || !parts.h1) return null;
  return { ts: parts.ts, h1: parts.h1 };
}

export async function verifyPaddleSignature(
  rawBody: string, header: string, secret: string, maxAgeSeconds = 60_000,
): Promise<boolean> {
  const parsed = parsePaddleSignature(header);
  if (!parsed) return false;
  const age = Math.abs(Date.now() / 1000 - Number(parsed.ts));
  if (!Number.isFinite(age) || age > maxAgeSeconds) return false;
  const expected = await hmacSha256(secret, `${parsed.ts}:${rawBody}`);
  if (expected.length !== parsed.h1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parsed.h1.charCodeAt(i);
  return diff === 0;
}

function planForPrice(env: PaddleEnv, priceId: string): PlanKey | "report" | null {
  if (priceId && priceId === (env.PADDLE_PRICE_PRO ?? "")) return "pro";
  if (priceId && priceId === (env.PADDLE_PRICE_AGENCY ?? "")) return "agency";
  if (priceId && priceId === (env.PADDLE_PRICE_REPORT ?? "")) return "report";
  return null;
}

function extractEmail(event: Record<string, unknown>): string {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const customData = (data.custom_data ?? {}) as Record<string, unknown>;
  if (typeof customData.email === "string") return customData.email;
  const items = Array.isArray(data.items) ? data.items : [];
  for (const item of items) {
    const price = ((item as Record<string, unknown>).price ?? {}) as Record<string, unknown>;
    if (typeof price.id === "string") continue;
  }
  const customer = (data.customer ?? {}) as Record<string, unknown>;
  if (typeof customer.email === "string") return customer.email;
  return (data.email as string) ?? (customData.email as string) ?? "";
}

function extractPriceId(event: Record<string, unknown>): string {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const items = Array.isArray(data.items) ? data.items : [];
  for (const item of items) {
    const price = ((item as Record<string, unknown>).price ?? {}) as Record<string, unknown>;
    if (typeof price.id === "string") return price.id;
  }
  return "";
}

/** Best-effort only — the exact Paddle payload shape for a given event type
 * has not been observed against a real account here, so this is read
 * defensively and the full raw event is always kept in raw_json regardless
 * of whether this finds anything. Never let a miss here block plan updates. */
function extractAmount(event: Record<string, unknown>): { amount: string | null; currency: string | null } {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const details = (data.details ?? {}) as Record<string, unknown>;
  const totals = (details.totals ?? {}) as Record<string, unknown>;
  if (typeof totals.total === "string") {
    return { amount: totals.total, currency: typeof data.currency_code === "string" ? data.currency_code : null };
  }
  const items = Array.isArray(data.items) ? data.items : [];
  for (const item of items) {
    const price = ((item as Record<string, unknown>).price ?? {}) as Record<string, unknown>;
    const unitPrice = (price.unit_price ?? {}) as Record<string, unknown>;
    if (typeof unitPrice.amount === "string") {
      return { amount: unitPrice.amount, currency: typeof unitPrice.currency_code === "string" ? unitPrice.currency_code : null };
    }
  }
  return { amount: null, currency: null };
}

/** The Deep Report's actual fulfillment: build it from whatever scan already
 * exists for the buyer's store and email it immediately. This used to be a
 * $9 charge with nothing behind it — every path here still ends in an
 * email, even when there's no store or no scan yet, so a buyer is never
 * just left wondering whether anything happened. */
async function deliverDeepReport(store: AppStore, env: PaddleEnv, userId: string, email: string): Promise<void> {
  const stores = await store.listStores(userId);
  if (!stores.length) {
    await sendEmail(env, email, "Your AgentReady deep report",
      `<p>Thanks for buying the deep report — you don't have a store connected yet, so there's nothing to report on.` +
      ` Connect a store and run a scan, then reply to this email and we'll send your report.</p>`);
    return;
  }
  const scanRow = await store.getLatestScanForStoreUrl(stores[0].storeUrl);
  if (!scanRow) {
    await sendEmail(env, email, "Your AgentReady deep report",
      `<p>Thanks for buying the deep report — ${stores[0].storeUrl} hasn't been scanned yet.` +
      ` Run the free scan from your dashboard, then reply to this email and we'll send your report.</p>`);
    return;
  }
  const scan = JSON.parse(scanRow.resultJson) as ScanResult;
  const aiJudge = await judgeReadiness(env, scan.storeUrl, scan.sampleProducts ?? []);
  await sendEmail(env, email, "Your AgentReady deep report", deepReportEmailHtml(scan as DeepReportScan, aiJudge));
}

export async function handlePaddleWebhook(
  request: Request, env: PaddleEnv, store: AppStore,
): Promise<{ status: number; body: unknown }> {
  const secret = env.PADDLE_WEBHOOK_SECRET ?? "";
  if (!secret) return { status: 503, body: { error: "webhooks not configured" } };
  const rawBody = await request.text();
  const signature = request.headers.get("paddle-signature") ?? "";
  if (!await verifyPaddleSignature(rawBody, signature, secret)) {
    return { status: 401, body: { error: "invalid signature" } };
  }
  let event: Record<string, unknown>;
  try { event = JSON.parse(rawBody) as Record<string, unknown>; } catch {
    return { status: 400, body: { error: "invalid json" } };
  }
  const eventType = String(event.event_type ?? "");
  const email = extractEmail(event).toLowerCase();
  if (!email) return { status: 200, body: { ok: true, ignored: "no email" } };
  const user = await store.getUserByEmail(email);
  if (!user) return { status: 200, body: { ok: true, ignored: "unknown user" } };

  const priceId = extractPriceId(event);
  const plan = planForPrice(env, priceId);

  if (eventType.startsWith("subscription.") &&
      ["subscription.activated", "subscription.resumed", "subscription.updated"].includes(eventType)) {
    if (plan === "pro" || plan === "agency") {
      // A resumed/updated event on an already-active subscription re-fires
      // this webhook without a new sale, and the UPDATE below reports a row
      // changed either way — the plan comparison, not the write, is what
      // separates a real conversion from a replay.
      const before = await store.listStores(user.id);
      const previousPlan = before[0]?.plan;
      await store.setStorePlanByUser(user.id, plan);
      if (previousPlan !== plan) {
        await store.recordFunnelEvent({ kind: "checkout_completed", userId: user.id, plan });
        const { amount, currency } = extractAmount(event);
        await store.recordBillingEvent({
          userId: user.id, eventType: eventType === "subscription.activated" ? "activated" : "updated",
          plan, amount, currency, raw: event,
        });
      }
      return { status: 200, body: { ok: true, plan } };
    }
  }
  if (eventType === "subscription.canceled" || eventType === "subscription.past_due") {
    await store.setStorePlanByUser(user.id, "free");
    await store.recordBillingEvent({
      userId: user.id, eventType: eventType === "subscription.canceled" ? "canceled" : "past_due",
      plan: "free", raw: event,
    });
    return { status: 200, body: { ok: true, plan: "free" } };
  }
  // Pro is a one-time "catalog unlock" purchase (no billing_cycle on the
  // Paddle price), not a subscription — Paddle fires transaction.completed
  // for it, the same event family as the report purchase, never
  // subscription.*. There is deliberately no cancellation path: once
  // unlocked, it stays unlocked. Idempotency mirrors the subscription
  // branch above (compare against the current plan) so a webhook retry on
  // the same transaction doesn't double-record history.
  if (eventType === "transaction.completed" && plan === "pro") {
    const before = await store.listStores(user.id);
    const previousPlan = before[0]?.plan;
    await store.setStorePlanByUser(user.id, "pro");
    if (previousPlan !== "pro") {
      await store.recordFunnelEvent({ kind: "checkout_completed", userId: user.id, plan: "pro" });
      const { amount, currency } = extractAmount(event);
      await store.recordBillingEvent({ userId: user.id, eventType: "activated", plan: "pro", amount, currency, raw: event });
    }
    return { status: 200, body: { ok: true, plan: "pro" } };
  }
  if (eventType === "transaction.completed" && plan === "report") {
    await store.recordFunnelEvent({ kind: "checkout_completed", userId: user.id, plan: "report" });
    const { amount, currency } = extractAmount(event);
    await store.recordBillingEvent({ userId: user.id, eventType: "report_purchase", plan: "report", amount, currency, raw: event });
    await deliverDeepReport(store, env, user.id, user.email);
    return { status: 200, body: { ok: true, note: "report purchase recorded" } };
  }
  return { status: 200, body: { ok: true, ignored: eventType || "unmapped" } };
}
