// Paddle Billing webhook: verify signature, map price -> plan, activate.
// Paddle signs webhooks with HMAC-SHA256 over "ts:rawBody" using the
// webhook secret; the signature arrives as "Paddle-Signature: ts=..;h1=..".
import { AppStore, type PlanKey } from "./core/appStore.ts";
import { sendEmail, deepReportEmailHtml, type DeepReportScan } from "./core/email.ts";
import { escapeHtml } from "./web.ts";
import { AI_MODEL, AI_RESERVED_NEURONS_PER_PACKET, judgeReadiness } from "./core/aiJudge.ts";
import type { ScanResult } from "./core/scan.ts";

export interface PaddleEnv {
  PADDLE_WEBHOOK_SECRET?: string;
  PADDLE_PRICE_REPORT?: string;
  PADDLE_PRICE_PRO?: string;
  PADDLE_PRICE_AGENCY?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  AI?: import("./core/aiJudge.ts").WorkersAiBinding;
}

const AI_DAILY_NEURON_CAP = 8_000;

function kstDay(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const field = (kind: "year" | "month" | "day") => parts.find(part => part.type === kind)?.value ?? "00";
  return `${field("year")}-${field("month")}-${field("day")}`;
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

/** Paddle's own transaction id — the natural idempotency key for a purchase. */
function extractTransactionId(event: Record<string, unknown>): string {
  const data = (event.data ?? {}) as Record<string, unknown>;
  return typeof data.id === "string" ? data.id : "";
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
 * defensively. Only normalized amount and currency are retained; raw Paddle
 * event payloads are intentionally not persisted. Never let a miss here
 * block plan updates. */
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

/** The Commerce Readiness Packet's actual fulfillment: build it from whatever scan already
 * exists for the buyer's store and email it immediately. This used to be a
 * $9 charge with nothing behind it — every path here still ends in an
 * email, even when there's no store or no scan yet, so a buyer is never
 * just left wondering whether anything happened. */
/** Try to settle an owed Commerce Readiness Packet. Returns true when one was delivered.
 *
 * Both "not yet" branches used to end in "reply to this email and we'll send
 * your report" — a fulfilment that depended on the buyer writing in and a
 * human answering. The entitlement row now carries the debt instead, so the
 * mail can promise automatic delivery, and `settleOwedReport` is called again
 * from the scan path the moment the missing scan appears.
 *
 * The delivered HTML is stored on the entitlement, which is what lets a buyer
 * returning in a later session see what their $9 bought instead of hunting
 * through their inbox. */
export async function settleOwedReport(
  store: AppStore, env: PaddleEnv, userId: string, email: string,
): Promise<boolean> {
  const owed = await store.oldestUnfulfilledReport(userId);
  if (!owed) return false;

  const stores = await store.listStores(userId);
  if (!stores.length) {
    await sendEmail(env, email, "Your AgentReady Commerce Readiness Packet",
      `<p>Thanks for buying the Commerce Readiness Packet. You don't have a store connected yet, so there's nothing to report on.` +
      ` Connect a store and run the free scan — your report is already paid for and will be sent automatically` +
      ` the moment the scan finishes. Nothing to reply to.</p>`);
    return false;
  }
  const scanRow = await store.getLatestScanForStoreUrl(stores[0].storeUrl);
  if (!scanRow) {
    await sendEmail(env, email, "Your AgentReady Commerce Readiness Packet",
      `<p>Thanks for buying the Commerce Readiness Packet. ${stores[0].storeUrl} hasn't been scanned yet.` +
      ` Run the free scan from your dashboard — your report is already paid for and will be sent automatically` +
      ` the moment the scan finishes. Nothing to reply to.</p>`);
    return false;
  }
  const scan = JSON.parse(scanRow.resultJson) as ScanResult;
  // The most recent scan abstained: nothing was read, so there is no fix list
  // to sell. Leave the entitlement owed rather than mailing a paid report whose
  // every line would be "the store did not answer" — settleOwedReportsForStoreUrl
  // runs again after the next scan and delivers it then.
  if (scan.state === "UNREADABLE" || scan.score === null) {
    await sendEmail(env, email, "Your AgentReady Commerce Readiness Packet",
      `<p>Thanks for buying the Commerce Readiness Packet. The last scan of ${escapeHtml(stores[0].storeUrl)}` +
      ` could not read the store, so there is no fix list to send yet — we will not bill you for a report about` +
      ` a request that failed. Run the free scan again once the store answers, and your report is sent` +
      ` automatically. It stays paid for. Nothing to reply to.</p>`);
    return false;
  }
  const day = kstDay();
  const aiReserved = env.AI
    ? await store.reserveAiBudget(day, AI_MODEL, AI_RESERVED_NEURONS_PER_PACKET, AI_DAILY_NEURON_CAP)
    : false;
  const aiJudge = aiReserved ? await judgeReadiness(env, scan.sampleProducts ?? []) : null;
  if (aiReserved) await store.markAiOutcome(day, AI_MODEL, aiJudge ? "success" : "unavailable");
  const html = deepReportEmailHtml(scan as DeepReportScan, aiJudge);
  // Mark it settled before mailing: a claim that survives a failed send is a
  // report the buyer can still open in the app, whereas double-marking would
  // silently drop a second purchase.
  await store.fulfilReportEntitlement(owed.id, scanRow.id, email, html);
  await sendEmail(env, email, "Your AgentReady Commerce Readiness Packet", html);
  return true;
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
  const priceId = extractPriceId(event);
  const plan = planForPrice(env, priceId);

  const user = await store.getUserByEmail(email);
  if (!user) {
    // Paid under an address with no account. Hold the purchase rather than
    // dropping it — see recordUnclaimedPurchase() for why a 200 with
    // "ignored" was the wrong answer.
    if (eventType === "transaction.completed" && plan) {
      const { amount, currency } = extractAmount(event);
      await store.recordUnclaimedPurchase({
        transactionId: extractTransactionId(event) || crypto.randomUUID(),
        email, priceId, amount, currency,
      });
      return { status: 200, body: { ok: true, held: "unclaimed purchase recorded" } };
    }
    return { status: 200, body: { ok: true, ignored: "unknown user" } };
  }

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
          plan, amount, currency,
        });
      }
      return { status: 200, body: { ok: true, plan } };
    }
  }
  if (eventType === "subscription.canceled" || eventType === "subscription.past_due") {
    await store.setStorePlanByUser(user.id, "free");
    await store.recordBillingEvent({
      userId: user.id, eventType: eventType === "subscription.canceled" ? "canceled" : "past_due",
      plan: "free",
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
      await store.recordBillingEvent({ userId: user.id, eventType: "activated", plan: "pro", amount, currency });
    }
    return { status: 200, body: { ok: true, plan: "pro" } };
  }
  if (eventType === "transaction.completed" && plan === "report") {
    await store.recordFunnelEvent({ kind: "checkout_completed", userId: user.id, plan: "report" });
    const { amount, currency } = extractAmount(event);
    await store.recordBillingEvent({ userId: user.id, eventType: "report_purchase", plan: "report", amount, currency });
    // Record the debt first, then try to settle it. If the buyer has no scan
    // yet the entitlement stays open and the scan path settles it later.
    await store.createReportEntitlement(user.id);
    await settleOwedReport(store, env, user.id, user.email);
    return { status: 200, body: { ok: true, note: "report purchase recorded" } };
  }
  return { status: 200, body: { ok: true, ignored: eventType || "unmapped" } };
}


/** Attach anything already paid for under this address.
 *
 * Called wherever an account and an email meet — signup, login, Google
 * sign-in — so a buyer who paid before registering, or paid under a
 * different address and then signed in with it, gets what they bought
 * without filing a support ticket.
 *
 * A report purchase becomes an entitlement (settled here if a scan already
 * exists, otherwise the scan path settles it later), and a plan purchase
 * sets the plan on the buyer's store. Never throws: a failed claim must not
 * block a login, and the rows stay unclaimed for the next attempt.
 */
export async function claimPurchases(
  store: AppStore, env: PaddleEnv, userId: string, email: string,
): Promise<number> {
  try {
    const owed = await store.unclaimedPurchasesFor(email);
    let claimed = 0;
    for (const purchase of owed) {
      const plan = planForPrice(env, purchase.priceId ?? "");
      if (!plan) continue;
      if (plan === "report") {
        await store.createReportEntitlement(userId);
        await store.recordBillingEvent({
          userId, eventType: "report_purchase", plan: "report",
          amount: purchase.amount, currency: purchase.currency,
        });
        await settleOwedReport(store, env, userId, email);
      } else {
        await store.setStorePlanByUser(userId, plan);
        await store.recordBillingEvent({
          userId, eventType: "activated", plan,
          amount: purchase.amount, currency: purchase.currency,
        });
      }
      await store.markPurchaseClaimed(purchase.transactionId, userId);
      claimed += 1;
    }
    return claimed;
  } catch {
    return 0;
  }
}
