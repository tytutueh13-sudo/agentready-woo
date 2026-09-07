// Integration tests for the funnel instrumentation added to app.ts:
// scan_completed, wall_shown (free-plan catalog truncation), and the
// checkout_started redirect routes. handleAppRequest has no prior test
// coverage, so these exercise it directly rather than only its pieces.
import test from "node:test";
import assert from "node:assert/strict";
import { handleAppRequest, type AppEnv } from "../src/app.ts";
import { AppStore } from "../src/core/appStore.ts";
import { encryptSecret, encryptionSecret } from "../src/core/tenants.ts";
import { newSessionToken, hashToken, sessionCookie, hashPassword, verifyPassword } from "../src/core/auth.ts";
import { RevenueGuard } from "../src/core/guard.ts";
import { MemoryStore } from "../src/core/memoryStore.ts";
import { MockPaymentProvider } from "../src/core/paymentProvider.ts";
import { sqliteD1 } from "./helpers/sqlite.ts";
import type { RevenueGuardConfig } from "../src/core/pricing.ts";

const EMAIL = "merchant@example.com";
const MASTER_SECRET = ["app", "encryption", "fixture", "not-real"].join("-");

function baseConfig(overrides: Partial<RevenueGuardConfig> = {}): RevenueGuardConfig {
  return {
    minGrossMarginRatio: 0.70, minPriceMultiplier: 3.0,
    perRequestMaxCost: 0.50, dailyMaxCost: 20.0, monthlyMaxCost: 300.0,
    perUserDailyCost: 2.0, perProductDailyCost: 20.0,
    rateLimitWindowSeconds: 60, rateLimitMaxRequests: 30,
    circuitBreakerFailureThreshold: 3, circuitBreakerWindowSeconds: 60, circuitBreakerCooldownSeconds: 60,
    cacheDefaultTtlSeconds: 3600,
    ...overrides,
  };
}

function guard(): RevenueGuard {
  return new RevenueGuard(new MemoryStore(), baseConfig(), new MockPaymentProvider(), {});
}

function env(overrides: Partial<AppEnv> = {}, db?: unknown): AppEnv {
  return {
    FINANCIAL_DB: db, APP_ENCRYPTION_SECRET: MASTER_SECRET,
    CART_SIGNING_SECRET: "cart-fixture-secret", PUBLIC_BASE_URL: "https://worker.example.com",
    ...overrides,
  };
}

async function setupUserWithStore(app: AppStore, plan: "free" | "pro" | "agency" = "free") {
  await app.createUser("u1", EMAIL, "pbkdf2$100000$abc$def");
  const master = encryptionSecret({ APP_ENCRYPTION_SECRET: MASTER_SECRET } as Record<string, string | undefined>);
  await app.createStore({
    id: "s1", userId: "u1", name: "NorthWind", storeUrl: "https://northwind.example.com",
    wooKeyEnc: await encryptSecret("ck_fixture", master), wooSecretEnc: await encryptSecret("cs_fixture", master),
    plan, status: "active", createdAt: 1, updatedAt: 1,
  });
  const token = newSessionToken();
  await app.createSession({ tokenHash: await hashToken(token), userId: "u1", createdAt: 1, expiresAt: Date.now() + 60_000 });
  return { token };
}

// GET/POST /dashboard/store/:id only matches a 36-char UUID-shaped id
// (see the editMatch regex in app.ts) — "s1" from setupUserWithStore()
// above is fine for /feed/:id (no such restriction) but not for the edit
// route, so the edit-path tests need their own real-UUID-shaped store.
const EDIT_STORE_ID = "11111111-1111-1111-1111-111111111111";

async function setupUserWithEditableStore(app: AppStore) {
  await app.createUser("u1", EMAIL, "pbkdf2$100000$abc$def");
  const master = encryptionSecret({ APP_ENCRYPTION_SECRET: MASTER_SECRET } as Record<string, string | undefined>);
  await app.createStore({
    id: EDIT_STORE_ID, userId: "u1", name: "NorthWind", storeUrl: "https://northwind.example.com",
    wooKeyEnc: await encryptSecret("ck_fixture", master), wooSecretEnc: await encryptSecret("cs_fixture", master),
    plan: "free", status: "active", createdAt: 1, updatedAt: 1,
  });
  const token = newSessionToken();
  await app.createSession({ tokenHash: await hashToken(token), userId: "u1", createdAt: 1, expiresAt: Date.now() + 60_000 });
  return { token };
}

test("GET /feed/:id on a free store past 25 offers records wall_shown once", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await setupUserWithStore(app, "free");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(
    Array.from({ length: 30 }, (_, i) => ({ id: i, name: `Item ${i}`, price: "10.00", status: "publish" })),
  ), { status: 200 })) as typeof fetch;
  try {
    const url = new URL("https://worker.example.com/feed/s1");
    const res = await handleAppRequest(new Request(url), env({}, db), url, guard());
    assert.equal(res?.status, 200);
    const body = await res!.json() as { truncated: boolean; offers: unknown[] };
    assert.equal(body.truncated, true);
    assert.equal(body.offers.length, 25);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const summary = await app.funnelSummary(0);
  assert.equal(summary.find(r => r.kind === "wall_shown")?.count, 1);
});

test("GET /feed/:id on a pro store is not truncated and records no wall_shown", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await setupUserWithStore(app, "pro");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(
    Array.from({ length: 30 }, (_, i) => ({ id: i, name: `Item ${i}`, price: "10.00", status: "publish" })),
  ), { status: 200 })) as typeof fetch;
  try {
    const url = new URL("https://worker.example.com/feed/s1");
    const res = await handleAppRequest(new Request(url), env({}, db), url, guard());
    const body = await res!.json() as { truncated: boolean };
    assert.equal(body.truncated, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const summary = await app.funnelSummary(0);
  assert.equal(summary.find(r => r.kind === "wall_shown")?.count, 0);
});

// POST /mcp/:id used to require x402 payment proof for every call, sharing
// the guard with the unrelated global readiness-scan tool. A merchant on a
// paid plan expects agents to actually be able to call this — see the fix
// in app.ts for the full reasoning. These tests lock in the replacement
// behavior: gated by the store's plan, not by an unrelated payment rail.
function mockWooFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const idMatch = url.match(/\/products\/(\d+)(?:\?|$)/);
    if (idMatch) {
      const id = Number(idMatch[1]);
      return new Response(JSON.stringify({ id, name: `Item ${id}`, price: "10.00", stock_status: "instock", status: "publish" }), { status: 200 });
    }
    return new Response(JSON.stringify(
      Array.from({ length: 30 }, (_, i) => ({ id: i, name: `Item ${i}`, price: "10.00", stock_status: "instock", status: "publish" })),
    ), { status: 200, headers: { "x-wp-total": "30" } });
  }) as typeof fetch;
}

test("POST /mcp/:id get_feed on a free store is truncated to 25, same as /feed", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await setupUserWithStore(app, "free");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockWooFetch();
  try {
    const request = new Request("https://worker.example.com/mcp/s1", {
      method: "POST", body: JSON.stringify({ tool: "agentready_woo_agentic_commerce_readiness_toolkit_for_self_h", input: { action: "get_feed" } }),
    });
    const url = new URL(request.url);
    const res = await handleAppRequest(request, env({}, db), url, guard());
    assert.equal(res?.status, 200);
    const body = await res!.json() as { result: { offers: unknown[]; truncated: boolean } };
    assert.equal(body.result.offers.length, 25);
    assert.equal(body.result.truncated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /mcp/:id get_offer for a product outside the free plan's top 25 is refused, not payment-gated", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await setupUserWithStore(app, "free");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockWooFetch();
  try {
    const request = new Request("https://worker.example.com/mcp/s1", {
      method: "POST", body: JSON.stringify({ tool: "agentready_woo_agentic_commerce_readiness_toolkit_for_self_h", input: { action: "get_offer", product_id: 27 } }),
    });
    const url = new URL(request.url);
    const res = await handleAppRequest(request, env({}, db), url, guard());
    assert.equal(res?.status, 403);
    const body = await res!.json() as { error: string };
    assert.match(body.error, /upgrade/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /mcp/:id get_offer for a product inside the free plan's top 25 succeeds with no payment step", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await setupUserWithStore(app, "free");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockWooFetch();
  try {
    const request = new Request("https://worker.example.com/mcp/s1", {
      method: "POST", body: JSON.stringify({ tool: "agentready_woo_agentic_commerce_readiness_toolkit_for_self_h", input: { action: "get_offer", product_id: 3 } }),
    });
    const url = new URL(request.url);
    const res = await handleAppRequest(request, env({}, db), url, guard());
    assert.equal(res?.status, 200);
    const body = await res!.json() as { result: { offer: { id: number } } };
    assert.equal(body.result.offer.id, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /mcp/:id get_offer on a pro store is never limited, for any product id", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await setupUserWithStore(app, "pro");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockWooFetch();
  try {
    const request = new Request("https://worker.example.com/mcp/s1", {
      method: "POST", body: JSON.stringify({ tool: "agentready_woo_agentic_commerce_readiness_toolkit_for_self_h", input: { action: "get_offer", product_id: 27 } }),
    });
    const url = new URL(request.url);
    const res = await handleAppRequest(request, env({}, db), url, guard());
    assert.equal(res?.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /mcp/:id rejects an unknown tool name", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await setupUserWithStore(app, "free");
  const request = new Request("https://worker.example.com/mcp/s1", {
    method: "POST", body: JSON.stringify({ tool: "not-the-right-tool", input: { action: "get_feed" } }),
  });
  const url = new URL(request.url);
  const res = await handleAppRequest(request, env({}, db), url, guard());
  assert.equal(res?.status, 400);
});

test("GET /dashboard/billing renders live Paddle.js checkout buttons for Pro and the deep report when the client token is set", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupUserWithStore(app, "free");
  const request = new Request("https://worker.example.com/dashboard/billing", {
    headers: { cookie: `arw_session=${token}` },
  });
  const url = new URL(request.url);
  const testEnv = env({ PADDLE_CLIENT_TOKEN: "live_fixture", PADDLE_PRICE_PRO: "pri_pro_fixture", PADDLE_PRICE_REPORT: "pri_report_fixture" }, db);
  const res = await handleAppRequest(request, testEnv, url, guard());
  const html = await res!.text();
  assert.match(html, /id="paddle-pro-btn"/);
  assert.match(html, /id="paddle-report-btn"/);
  assert.doesNotMatch(html, /disabled title="Payments are being set up/);
  assert.doesNotMatch(html, /pay\.paddle\.com/);
  assert.match(html, /cdn\.paddle\.com\/paddle\/v2\/paddle\.js/);
});

test("GET /dashboard/billing falls back to a disabled 'Coming soon' button for the deep report when no Paddle client token is configured", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupUserWithStore(app, "free");
  const request = new Request("https://worker.example.com/dashboard/billing", {
    headers: { cookie: `arw_session=${token}` },
  });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  const html = await res!.text();
  assert.match(html, /Commerce Readiness Packet — \$9<\/button>/);
  assert.match(html, /disabled title="Payments are being set up/);
  assert.doesNotMatch(html, /cdn\.paddle\.com/);
});

test("POST /dashboard/billing/checkout-started records checkout_started for a valid plan", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupUserWithStore(app, "free");
  const request = new Request("https://worker.example.com/dashboard/billing/checkout-started", {
    method: "POST", headers: { cookie: `arw_session=${token}`, "content-type": "application/json" },
    body: JSON.stringify({ plan: "pro" }),
  });
  const testEnv = env({ PADDLE_CLIENT_TOKEN: "live_fixture", PADDLE_PRICE_PRO: "pri_pro_fixture" }, db);
  const res = await handleAppRequest(request, testEnv, new URL(request.url), guard());
  assert.equal(res?.status, 204);
  const summary = await app.funnelSummary(0);
  const started = summary.find(r => r.kind === "checkout_started");
  assert.equal(started?.count, 1);
});

test("POST /dashboard/billing/checkout-started ignores an invalid plan (no funnel row, no crash)", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupUserWithStore(app, "free");
  const request = new Request("https://worker.example.com/dashboard/billing/checkout-started", {
    method: "POST", headers: { cookie: `arw_session=${token}`, "content-type": "application/json" },
    body: JSON.stringify({ plan: "nonsense" }),
  });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  assert.equal(res?.status, 204);
  const summary = await app.funnelSummary(0);
  assert.equal(summary.find(r => r.kind === "checkout_started")?.count, 0);
});

test("scan (form) records scan_completed with the score", async () => {
  const { db } = sqliteD1();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const path = new URL(String(input)).pathname;
    if (path === "/wp-json/wc/store/v1/products") return new Response("[]", { status: 200, headers: { "x-wp-total": "0" } });
    return new Response("<html></html>", { status: 200 });
  }) as typeof fetch;
  try {
    const form = new URLSearchParams({ store_url: "https://northwind.example.com" });
    const request = new Request("https://worker.example.com/scan", {
      method: "POST", body: form.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
    assert.equal(res?.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const app = new AppStore(db);
  const summary = await app.funnelSummary(0);
  assert.equal(summary.find(r => r.kind === "scan_completed")?.count, 1);
});

test("GET /ops/funnel fails closed with 503 when OPS_TOKEN is not configured", async () => {
  const { db } = sqliteD1();
  const request = new Request("https://worker.example.com/ops/funnel");
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  assert.equal(res?.status, 503);
});

test("GET /ops/funnel rejects a missing or wrong bearer token", async () => {
  const { db } = sqliteD1();
  const testEnv = env({ OPS_TOKEN: "a".repeat(40) }, db);
  const noAuth = await handleAppRequest(
    new Request("https://worker.example.com/ops/funnel"), testEnv,
    new URL("https://worker.example.com/ops/funnel"), guard(),
  );
  assert.equal(noAuth?.status, 401);
  const wrongAuth = await handleAppRequest(
    new Request("https://worker.example.com/ops/funnel", { headers: { authorization: "Bearer wrong" } }), testEnv,
    new URL("https://worker.example.com/ops/funnel"), guard(),
  );
  assert.equal(wrongAuth?.status, 401);
});

test("GET /ops/funnel returns the funnel counts with a valid bearer token", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  // A real scan always records its outcome; a bare event is an unclassifiable
  // legacy row and is deliberately not counted as an answered scan.
  await app.recordFunnelEvent({ kind: "scan_completed", meta: { score: 61, state: "SCORED" } });
  await app.recordFunnelEvent({ kind: "checkout_started", plan: "pro" });
  const token = "b".repeat(40);
  const testEnv = env({ OPS_TOKEN: token }, db);
  const request = new Request("https://worker.example.com/ops/funnel", { headers: { authorization: `Bearer ${token}` } });
  const res = await handleAppRequest(request, testEnv, new URL(request.url), guard());
  assert.equal(res?.status, 200);
  const body = await res!.json() as { since_days: number; funnel: { kind: string; count: number }[] };
  assert.equal(body.since_days, 30);
  assert.equal(body.funnel.find(r => r.kind === "scan_completed")?.count, 1);
  assert.equal(body.funnel.find(r => r.kind === "checkout_started")?.count, 1);
});

// --- Store form bugs found by hand while UI-auditing the live app -----------

test("GET /dashboard/store shows the authenticated nav, not the logged-out one", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupUserWithStore(app);
  const request = new Request("https://worker.example.com/dashboard/store", {
    headers: { cookie: `arw_session=${token}` },
  });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  const html = await res!.text();
  assert.match(html, new RegExp(EMAIL.replace(".", "\\.")), "must show who is logged in");
  assert.match(html, /Log out/);
  assert.doesNotMatch(html, /Free scan<\/a>\s*<\/div>\s*<\/div>\s*<\/nav>/, "must not fall back to the public nav");
});

test("GET /dashboard/store/:id (edit) also shows the authenticated nav", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupUserWithEditableStore(app);
  const request = new Request(`https://worker.example.com/dashboard/store/${EDIT_STORE_ID}`, {
    headers: { cookie: `arw_session=${token}` },
  });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  const html = await res!.text();
  assert.match(html, new RegExp(EMAIL.replace(".", "\\.")));
  assert.match(html, /Log out/);
});

test("Release Gate setup is owner-scoped, no-store, and keeps keys out of the initial page", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupUserWithEditableStore(app);
  const url = new URL(`https://worker.example.com/dashboard/store/${EDIT_STORE_ID}/release-gate`);
  const initial = await handleAppRequest(new Request(url, { headers: { cookie: `arw_session=${token}` } }), env({}, db), url, guard());
  assert.equal(initial?.status, 200);
  assert.equal(initial?.headers.get("cache-control"), "no-store");
  const initialHtml = await initial!.text();
  assert.match(initialHtml, /Four small steps/);
  assert.match(initialHtml, /Download plugin/);
  assert.match(initialHtml, /Signed evidence/);
  assert.doesNotMatch(initialHtml, /Connection bundle<\/strong>/);

  const opened = await handleAppRequest(new Request(url, {
    method: "POST",
    headers: { cookie: `arw_session=${token}`, origin: "https://worker.example.com" },
  }), env({ RELEASE_GATE_OWNERSHIP_SECRET: "ownership-root", RELEASE_EVIDENCE_CURRENT_KEY: "evidence-root" }, db), url, guard());
  assert.equal(opened?.status, 200);
  assert.equal(opened?.headers.get("cache-control"), "no-store");
  const openedHtml = await opened!.text();
  assert.match(openedHtml, /Connection bundle<\/strong>/);
  assert.match(openedHtml, new RegExp(EDIT_STORE_ID));
  assert.equal((openedHtml.match(/type="password"/g) ?? []).length, 2);
  assert.ok((openedHtml.match(/[a-f0-9]{64}/g) ?? []).length >= 2);
  const stored = JSON.stringify(await app.getStore(EDIT_STORE_ID));
  for (const key of openedHtml.match(/[a-f0-9]{64}/g) ?? []) assert.doesNotMatch(stored, new RegExp(key));
});

test("Release Gate setup fails closed when connection roots are unavailable", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupUserWithEditableStore(app);
  const url = new URL(`https://worker.example.com/dashboard/store/${EDIT_STORE_ID}/release-gate`);
  const response = await handleAppRequest(new Request(url, {
    method: "POST",
    headers: { cookie: `arw_session=${token}`, origin: "https://worker.example.com" },
  }), env({}, db), url, guard());
  assert.equal(response?.status, 503);
  assert.match(await response!.text(), /temporarily unavailable/);
});

test("editing a store's name without re-entering the secret keeps the original secret", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupUserWithEditableStore(app);
  const before = await app.getStore(EDIT_STORE_ID);
  const form = new URLSearchParams({
    name: "NorthWind Renamed", store_url: "https://northwind.example.com", consumer_key: "ck_fixture",
    // consumer_secret intentionally omitted — this used to be blocked by a
    // `required` field forcing re-entry just to fix a typo in the name.
  });
  const request = new Request(`https://worker.example.com/dashboard/store/${EDIT_STORE_ID}`, {
    method: "POST", body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `arw_session=${token}`, origin: "https://worker.example.com" },
  });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  assert.equal(res?.status, 302);
  const after = await app.getStore(EDIT_STORE_ID);
  assert.equal(after?.name, "NorthWind Renamed");
  assert.equal(after?.wooSecretEnc, before?.wooSecretEnc, "the untouched secret must be preserved byte-for-byte");
});

test("editing a store CAN still replace the secret when a new one is supplied", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupUserWithEditableStore(app);
  const before = await app.getStore(EDIT_STORE_ID);
  const form = new URLSearchParams({
    name: "NorthWind", store_url: "https://northwind.example.com",
    consumer_key: "ck_fixture", consumer_secret: "cs_brand_new_secret",
  });
  const request = new Request(`https://worker.example.com/dashboard/store/${EDIT_STORE_ID}`, {
    method: "POST", body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `arw_session=${token}`, origin: "https://worker.example.com" },
  });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  assert.equal(res?.status, 302);
  const after = await app.getStore(EDIT_STORE_ID);
  assert.notEqual(after?.wooSecretEnc, before?.wooSecretEnc);
});

test("editing a store with a malformed (but non-empty) secret is rejected, not silently accepted", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupUserWithEditableStore(app);
  const before = await app.getStore(EDIT_STORE_ID);
  const form = new URLSearchParams({
    name: "NorthWind", store_url: "https://northwind.example.com",
    consumer_key: "ck_fixture", consumer_secret: "not-a-real-secret",
  });
  const request = new Request(`https://worker.example.com/dashboard/store/${EDIT_STORE_ID}`, {
    method: "POST", body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `arw_session=${token}`, origin: "https://worker.example.com" },
  });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  assert.equal(res?.status, 200);
  const html = await res!.text();
  assert.match(html, /leave it blank to keep the current one/);
  const after = await app.getStore(EDIT_STORE_ID);
  assert.equal(after?.wooSecretEnc, before?.wooSecretEnc, "a rejected save must not touch the stored secret");
});

test("creating a store still requires a well-formed secret (no leave-blank shortcut on create)", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await app.createUser("u1", EMAIL, "pbkdf2$100000$abc$def");
  const token = newSessionToken();
  await app.createSession({ tokenHash: await hashToken(token), userId: "u1", createdAt: 1, expiresAt: Date.now() + 60_000 });
  const form = new URLSearchParams({
    name: "NorthWind", store_url: "https://northwind.example.com", consumer_key: "ck_fixture",
  });
  const request = new Request("https://worker.example.com/dashboard/store", {
    method: "POST", body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `arw_session=${token}`, origin: "https://worker.example.com" },
  });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  assert.equal(res?.status, 200);
  assert.equal(await app.getStore("s1"), null);
  assert.equal((await app.listStores("u1")).length, 0);
});

// --- password reset (forgot / reset) -----------------------------------

const REAL_PASSWORD = "correct horse battery staple";

async function setupUserWithRealPassword(app: AppStore) {
  const passwordHash = await hashPassword(REAL_PASSWORD);
  await app.createUser("u1", EMAIL, passwordHash);
  const token = newSessionToken();
  await app.createSession({ tokenHash: await hashToken(token), userId: "u1", createdAt: 1, expiresAt: Date.now() + 60_000 });
  return { token, passwordHash };
}

test("POST /forgot-password gives the identical response for a known and an unknown email", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await setupUserWithRealPassword(app);
  async function submit(email: string) {
    const form = new URLSearchParams({ email });
    const request = new Request("https://worker.example.com/forgot-password", {
      method: "POST", body: form.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
    return { status: res?.status, body: await res!.text() };
  }
  const known = await submit(EMAIL);
  const unknown = await submit("nobody@example.com");
  assert.equal(known.status, unknown.status);
  assert.equal(known.body, unknown.body);
});

test("POST /forgot-password for a known email creates a usable reset token", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await setupUserWithRealPassword(app);
  const form = new URLSearchParams({ email: EMAIL });
  const request = new Request("https://worker.example.com/forgot-password", {
    method: "POST", body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  const reset = await app.latestPasswordReset("u1");
  assert.ok(reset);
  assert.equal(reset?.usedAt, null);
});

test("GET /reset-password with an unknown token shows the expired page, not the form", async () => {
  const { db } = sqliteD1();
  const request = new Request("https://worker.example.com/reset-password?token=bogus");
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  assert.equal(res?.status, 400);
  const html = await res!.text();
  assert.match(html, /expired|invalid/i);
});

test("POST /reset-password with a valid token sets the new password and kills existing sessions", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token: sessionToken } = await setupUserWithRealPassword(app);
  const resetToken = newSessionToken();
  await app.createPasswordReset("u1", await hashToken(resetToken), 60 * 60 * 1000);
  const form = new URLSearchParams({ token: resetToken, password: "brand new password" });
  const request = new Request("https://worker.example.com/reset-password", {
    method: "POST", body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  assert.equal(res?.status, 302);
  assert.equal(res?.headers.get("location"), "/login");
  const user = await app.getUser("u1");
  assert.ok(await verifyPassword("brand new password", user!.passwordHash));
  assert.equal(await app.getSession(await hashToken(sessionToken)), null);
});

test("POST /reset-password rejects reuse of an already-consumed token", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await setupUserWithRealPassword(app);
  const resetToken = newSessionToken();
  await app.createPasswordReset("u1", await hashToken(resetToken), 60 * 60 * 1000);
  const form = new URLSearchParams({ token: resetToken, password: "first new password" });
  const first = new Request("https://worker.example.com/reset-password", {
    method: "POST", body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const firstRes = await handleAppRequest(first, env({}, db), new URL(first.url), guard());
  assert.equal(firstRes?.status, 302);
  const replay = new URLSearchParams({ token: resetToken, password: "second new password" });
  const second = new Request("https://worker.example.com/reset-password", {
    method: "POST", body: replay.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  const secondRes = await handleAppRequest(second, env({}, db), new URL(second.url), guard());
  assert.equal(secondRes?.status, 400);
  const user = await app.getUser("u1");
  assert.ok(await verifyPassword("first new password", user!.passwordHash), "second attempt must not have overwritten the password again");
});

// --- my-page: account (password / email / delete) ----------------------

test("POST /dashboard/account/password rejects the wrong current password", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token, passwordHash } = await setupUserWithRealPassword(app);
  const form = new URLSearchParams({ current_password: "totally wrong", new_password: "new password here" });
  const request = new Request("https://worker.example.com/dashboard/account/password", {
    method: "POST", body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `arw_session=${token}` },
  });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  assert.equal(res?.status, 302);
  assert.match(res!.headers.get("location") ?? "", /notice=error/);
  const user = await app.getUser("u1");
  assert.equal(user?.passwordHash, passwordHash);
});

test("POST /dashboard/account/password updates the password on a correct current password", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupUserWithRealPassword(app);
  const form = new URLSearchParams({ current_password: REAL_PASSWORD, new_password: "a fresh new password" });
  const request = new Request("https://worker.example.com/dashboard/account/password", {
    method: "POST", body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `arw_session=${token}` },
  });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  assert.equal(res?.status, 302);
  assert.match(res!.headers.get("location") ?? "", /notice=ok/);
  const user = await app.getUser("u1");
  assert.ok(await verifyPassword("a fresh new password", user!.passwordHash));
});

test("POST /dashboard/account/email rejects a duplicate email", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await app.createUser("other", "taken@example.com", await hashPassword("whatever"));
  const { token } = await setupUserWithRealPassword(app);
  const form = new URLSearchParams({ email_password: REAL_PASSWORD, new_email: "taken@example.com" });
  const request = new Request("https://worker.example.com/dashboard/account/email", {
    method: "POST", body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `arw_session=${token}` },
  });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  assert.match(res!.headers.get("location") ?? "", /notice=error/);
  const user = await app.getUser("u1");
  assert.equal(user?.email, EMAIL);
});

test("POST /dashboard/account/email changes the email on success", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupUserWithRealPassword(app);
  const form = new URLSearchParams({ email_password: REAL_PASSWORD, new_email: "new-address@example.com" });
  const request = new Request("https://worker.example.com/dashboard/account/email", {
    method: "POST", body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `arw_session=${token}` },
  });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  assert.match(res!.headers.get("location") ?? "", /notice=ok/);
  const user = await app.getUser("u1");
  assert.equal(user?.email, "new-address@example.com");
});

test("POST /dashboard/account/delete cascades: sessions, stores, Release Gate linkage, and the user row are gone", async () => {
  const { db, raw } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupUserWithEditableStore(app);
  const now = Date.now();
  await app.createReleaseChallenge("challenge_delete", EDIT_STORE_ID, "u1", "a".repeat(64), now + 60_000);
  await app.createReleaseApiToken({ id: "token_delete", accountId: "u1", tokenDigest: "b".repeat(64), name: "delete test", scopes: ["release:read"], storeId: EDIT_STORE_ID, createdAt: now, expiresAt: null, revokedAt: null });
  await app.blockReleaseApiToken("token_delete", "TEST_BLOCK");
  await app.recordPluginEvidence("receipt_delete", EDIT_STORE_ID, "u1", "nonce_delete_0001", "c".repeat(64), "{}", now + 60_000, now);
  await app.createOrGetReleaseRun({ id: "run_delete", accountId: "u1", storeId: EDIT_STORE_ID, mode: "owned-safe-active", requestedFamiliesJson: '["woo"]', baselineRunId: null, idempotencyKey: "delete_test_key_0001", state: "QUEUED", bundleDigest: "d".repeat(64) });
  // setupUserWithEditableStore doesn't hash a real password — set one the
  // confirmation check can actually verify against.
  await app.updateUserPassword("u1", await hashPassword(REAL_PASSWORD));
  const form = new URLSearchParams({ delete_password: REAL_PASSWORD });
  const request = new Request("https://worker.example.com/dashboard/account/delete", {
    method: "POST", body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `arw_session=${token}` },
  });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  assert.equal(res?.status, 302);
  assert.equal(res?.headers.get("location"), "/login");
  assert.equal(await app.getUser("u1"), null);
  assert.equal(await app.getStore(EDIT_STORE_ID), null);
  for (const table of ["release_gate_ownership_challenges", "release_gate_runs", "release_gate_evidence_commits", "release_gate_active_evidence", "release_gate_evidence_order", "release_gate_api_tokens", "release_gate_token_blocks"]) {
    assert.equal((raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, `${table} retained deleted-account linkage`);
  }
});

// --- operator admin panel -----------------------------------------------

test("GET /admin fails closed with 503 when ADMIN_PASSWORD is not configured", async () => {
  const { db } = sqliteD1();
  const request = new Request("https://worker.example.com/admin");
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  assert.equal(res?.status, 503);
});

test("GET /admin rejects a missing or wrong Basic Auth password", async () => {
  const { db } = sqliteD1();
  const testEnv = env({ ADMIN_PASSWORD: "a-real-admin-password" }, db);
  const noAuth = await handleAppRequest(
    new Request("https://worker.example.com/admin"), testEnv, new URL("https://worker.example.com/admin"), guard(),
  );
  assert.equal(noAuth?.status, 401);
  const wrongAuth = await handleAppRequest(
    new Request("https://worker.example.com/admin", { headers: { authorization: `Basic ${btoa("op:wrong")}` } }),
    testEnv, new URL("https://worker.example.com/admin"), guard(),
  );
  assert.equal(wrongAuth?.status, 401);
});

test("GET /admin lists users with a correct Basic Auth password", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await setupUserWithStore(app, "pro");
  const testEnv = env({ ADMIN_PASSWORD: "a-real-admin-password" }, db);
  const request = new Request("https://worker.example.com/admin", {
    headers: { authorization: `Basic ${btoa("op:a-real-admin-password")}` },
  });
  const res = await handleAppRequest(request, testEnv, new URL(request.url), guard());
  assert.equal(res?.status, 200);
  const html = await res!.text();
  assert.match(html, new RegExp(EMAIL.replace(".", "\\.")));
});

test("GET /admin/users/:id shows the user's stores and billing history", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await setupUserWithStore(app, "pro");
  await app.recordBillingEvent({ userId: "u1", eventType: "activated", plan: "pro", amount: "29.00", currency: "USD" });
  const testEnv = env({ ADMIN_PASSWORD: "a-real-admin-password" }, db);
  const request = new Request("https://worker.example.com/admin/users/u1", {
    headers: { authorization: `Basic ${btoa("op:a-real-admin-password")}` },
  });
  const res = await handleAppRequest(request, testEnv, new URL(request.url), guard());
  assert.equal(res?.status, 200);
  const html = await res!.text();
  assert.match(html, /NorthWind/);
  assert.match(html, /Plan activated/);
});

test("POST /admin/users/:id/reset-link generates a one-time-visible reset link and it actually works", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  await setupUserWithRealPassword(app);
  const testEnv = env({ ADMIN_PASSWORD: "a-real-admin-password" }, db);
  const request = new Request("https://worker.example.com/admin/users/u1/reset-link", {
    method: "POST", headers: { authorization: `Basic ${btoa("op:a-real-admin-password")}` },
  });
  const res = await handleAppRequest(request, testEnv, new URL(request.url), guard());
  assert.equal(res?.status, 200);
  const html = await res!.text();
  const match = html.match(/\/reset-password\?token=([A-Za-z0-9_-]+)/);
  assert.ok(match, "reset link must be shown in the response");
  const token = decodeURIComponent(match![1]);
  const resetReq = new Request(`https://worker.example.com/reset-password?token=${encodeURIComponent(token)}`);
  const resetRes = await handleAppRequest(resetReq, testEnv, new URL(resetReq.url), guard());
  assert.equal(resetRes?.status, 200);
});

// --- Google-linked accounts have no password to confirm with ------------

async function setupGoogleUser(app: AppStore) {
  await app.createUser("u1", EMAIL, "oauth:google:no-password");
  const token = newSessionToken();
  await app.createSession({ tokenHash: await hashToken(token), userId: "u1", createdAt: 1, expiresAt: Date.now() + 60_000 });
  return { token };
}

test("GET /dashboard/account shows 'Set a password' (not 'Change password') for a Google-linked account", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupGoogleUser(app);
  const request = new Request("https://worker.example.com/dashboard/account", { headers: { cookie: `arw_session=${token}` } });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  const html = await res!.text();
  assert.match(html, /Set a password/);
  assert.doesNotMatch(html, /Change password/);
  assert.doesNotMatch(html, /id="current_password"/, "no current-password field to fill in for an account that never had one");
});

test("POST /dashboard/account/password sets a first password for a Google-linked account with no current-password check", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupGoogleUser(app);
  const form = new URLSearchParams({ new_password: "a brand new password" });
  const request = new Request("https://worker.example.com/dashboard/account/password", {
    method: "POST", body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `arw_session=${token}` },
  });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  assert.equal(res?.status, 302);
  assert.match(res!.headers.get("location") ?? "", /notice=ok/);
  const user = await app.getUser("u1");
  assert.ok(await verifyPassword("a brand new password", user!.passwordHash));
});

test("POST /dashboard/account/email for a Google-linked account succeeds without a password field", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupGoogleUser(app);
  const form = new URLSearchParams({ new_email: "new-google-address@example.com" });
  const request = new Request("https://worker.example.com/dashboard/account/email", {
    method: "POST", body: form.toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `arw_session=${token}` },
  });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  assert.match(res!.headers.get("location") ?? "", /notice=ok/);
  const user = await app.getUser("u1");
  assert.equal(user?.email, "new-google-address@example.com");
});

test("POST /dashboard/account/delete for a Google-linked account succeeds without a password field", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupGoogleUser(app);
  const request = new Request("https://worker.example.com/dashboard/account/delete", {
    method: "POST", body: "",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `arw_session=${token}` },
  });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  assert.equal(res?.status, 302);
  assert.equal(res?.headers.get("location"), "/login");
  assert.equal(await app.getUser("u1"), null);
});

test("GET /dashboard/account shows the normal 'Change password' form once a Google-linked account has set one", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const { token } = await setupGoogleUser(app);
  await app.updateUserPassword("u1", await hashPassword("already set a password"));
  const request = new Request("https://worker.example.com/dashboard/account", { headers: { cookie: `arw_session=${token}` } });
  const res = await handleAppRequest(request, env({}, db), new URL(request.url), guard());
  const html = await res!.text();
  assert.match(html, /Change password/);
  assert.doesNotMatch(html, /Set a password/);
});
