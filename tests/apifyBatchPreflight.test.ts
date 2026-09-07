// The Apify Actor is a thin wrapper. These tests exist because a thin wrapper
// is exactly where the two expensive mistakes hide: charging for a result that
// was never produced, and reaching a target that should never have been
// reached. Neither is visible from the outside until a customer or a security
// report finds it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ABSTAINING_STATES, DEFAULT_CONCURRENCY, MAX_CONCURRENCY, MAX_ORIGINS,
  PRODUCTION_ENDPOINT, billableCount, normalizeOrigin, parseBatchInput,
  channelHeaders, itemKeyFor, parseFamilies, runBatch, toRow, type PreflightRow,
} from "../integrations/apify-batch-preflight/batch.ts";

// -- input: what must never reach the network -------------------------------

test("only public https origins survive validation", () => {
  assert.equal(normalizeOrigin("https://shop.example.com"), "https://shop.example.com");
  assert.equal(normalizeOrigin("  https://shop.example.com/  "), "https://shop.example.com");

  for (const [bad, code] of [
    ["http://shop.example.com", "ORIGIN_NOT_HTTPS"],
    ["https://user:pass@shop.example.com", "ORIGIN_CARRIES_CREDENTIALS"],
    ["https://shop.example.com/wp-admin", "ORIGIN_NOT_AN_ORIGIN"],
    ["https://shop.example.com/?token=abc", "ORIGIN_NOT_AN_ORIGIN"],
    ["https://localhost", "ORIGIN_PRIVATE_NETWORK"],
    ["https://127.0.0.1", "ORIGIN_PRIVATE_NETWORK"],
    ["https://10.0.0.5", "ORIGIN_PRIVATE_NETWORK"],
    ["https://192.168.1.10", "ORIGIN_PRIVATE_NETWORK"],
    ["https://169.254.169.254", "ORIGIN_PRIVATE_NETWORK"],
    ["https://172.16.0.1", "ORIGIN_PRIVATE_NETWORK"],
    ["https://intranet", "ORIGIN_NOT_PUBLIC"],
    ["not a url", "ORIGIN_CONTROL_CHARS"],
    ["https:/", "ORIGIN_LENGTH"],
    ["https://", "ORIGIN_UNPARSEABLE"],
    ["https://shop example.com", "ORIGIN_CONTROL_CHARS"],
  ] as const) {
    assert.throws(() => normalizeOrigin(bad), (e: Error & { code?: string }) => e.code === code,
      `${bad} should be refused as ${code}`);
  }
});

test("a credential in a URL is refused rather than written into a dataset", () => {
  const input = parseBatchInput({
    store_origins: ["https://ck_live_secret:cs_live_secret@shop.example.com", "https://shop.example.com"],
  });
  assert.deepEqual(input.origins, ["https://shop.example.com"]);
  assert.equal(input.rejected.length, 1);
  assert.equal(input.rejected[0].code, "ORIGIN_CARRIES_CREDENTIALS");
});

test("the batch is bounded, deduplicated, and its concurrency capped", () => {
  const input = parseBatchInput({
    store_origins: ["https://a.example.com", "https://a.example.com/", "https://b.example.com"],
    concurrency: 99,
  });
  assert.deepEqual(input.origins, ["https://a.example.com", "https://b.example.com"]);
  assert.equal(input.concurrency, MAX_CONCURRENCY);
  assert.equal(parseBatchInput({ store_origins: ["https://a.example.com"] }).concurrency, DEFAULT_CONCURRENCY);

  assert.throws(
    () => parseBatchInput({ store_origins: Array(MAX_ORIGINS + 1).fill("https://a.example.com") }),
    (e: Error & { code?: string }) => e.code === "STORE_ORIGINS_TOO_MANY");
  assert.throws(() => parseBatchInput({ store_origins: [] }),
    (e: Error & { code?: string }) => e.code === "STORE_ORIGINS_REQUIRED");
});

test("the endpoint cannot be pointed at a plaintext host", () => {
  assert.equal(parseBatchInput({ store_origins: ["https://a.example.com"], endpoint: "http://evil.example" }).endpoint,
    PRODUCTION_ENDPOINT);
  assert.equal(parseBatchInput({ store_origins: ["https://a.example.com"], endpoint: "https://staging.example/api" }).endpoint,
    "https://staging.example/api");
});

test("only the six families the server accepts are passed through", () => {
  assert.deepEqual(parseFamilies(["woo", "robots"]), ["woo", "robots"]);
  assert.equal(parseFamilies(undefined), null);
  assert.throws(() => parseFamilies(["woo", "notafamily"]),
    (e: Error & { code?: string }) => e.code === "FAMILIES_INVALID");
});

// -- outcomes: the rule that decides what may be charged --------------------

test("an HTTP 200 that says BLOCKED is an abstention, not a result", () => {
  for (const state of ABSTAINING_STATES) {
    const row = toRow("https://shop.example.com", null, {
      status: 200,
      body: { state, checks: [{ id: "target", state: "BLOCKED", reasonCode: "TARGET_PRIVATE" }], unknowns: ["TARGET_PRIVATE"] },
    });
    assert.equal(row.outcome, "ABSTAINED", `${state} must not be a useful result`);
    assert.equal(row.billable, false);
    assert.equal(row.reason, "TARGET_PRIVATE");
  }
});

test("a real answer is useful, and keeps the server's own states verbatim", () => {
  const row = toRow("https://shop.example.com", ["woo"], {
    status: 200,
    body: {
      state: "READY",
      checks: [
        { id: "woo_store_api", state: "PASS" },
        { id: "robots", state: "FAIL", reasonCode: "ROBOTS_BLOCKED" },
      ],
      unknowns: [],
      observed_at: "2026-09-07T06:20:31.073Z",
    },
  });
  assert.equal(row.outcome, "USEFUL");
  assert.equal(row.billable, true);
  assert.equal(row.state, "READY");
  assert.equal(row.checks_total, 2);
  assert.equal(row.checks_passed, 1);
  assert.equal(row.observed_at, "2026-09-07T06:20:31.073Z");
});

test("upstream failures are their own outcome and never billable", () => {
  const rateLimited = toRow("https://shop.example.com", null,
    { status: 429, body: { code: "TARGET_RATE_LIMITED" } });
  assert.equal(rateLimited.outcome, "UPSTREAM_FAILED");
  assert.equal(rateLimited.reason, "TARGET_RATE_LIMITED");
  assert.equal(rateLimited.billable, false);

  const timedOut = toRow("https://shop.example.com", null, { status: null, error: "REQUEST_TIMEOUT" });
  assert.equal(timedOut.outcome, "UPSTREAM_FAILED");
  assert.equal(timedOut.billable, false);

  const serverError = toRow("https://shop.example.com", null, { status: 503, body: {} });
  assert.equal(serverError.reason, "HTTP_503");
  assert.equal(serverError.billable, false);
});

test("a 200 with no checks at all is an abstention, not an empty success", () => {
  const row = toRow("https://shop.example.com", null, { status: 200, body: { state: "READY", checks: [] } });
  assert.equal(row.outcome, "ABSTAINED");
  assert.equal(row.billable, false);
});

test("the charge is per distinct answered origin, once", () => {
  const rows: PreflightRow[] = [
    toRow("https://a.example.com", null, { status: 200, body: { state: "READY", checks: [{ state: "PASS" }] } }),
    toRow("https://a.example.com", null, { status: 200, body: { state: "READY", checks: [{ state: "PASS" }] } }),
    toRow("https://b.example.com", null, { status: 200, body: { state: "BLOCKED", checks: [{ state: "BLOCKED" }] } }),
    toRow("https://c.example.com", null, { status: 429, body: { code: "TARGET_RATE_LIMITED" } }),
  ];
  assert.equal(billableCount(rows), 1);
});

// -- the run ----------------------------------------------------------------

test("a batch produces exactly one row per input, including the refused ones", async () => {
  const calls: string[] = [];
  const fake = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { store_origin: string };
    calls.push(body.store_origin);
    return new Response(JSON.stringify({
      state: "READY", checks: [{ id: "woo", state: "PASS" }], unknowns: [],
      observed_at: "2026-09-07T00:00:00.000Z",
    }), { status: 200 });
  }) as typeof fetch;

  const input = parseBatchInput({
    store_origins: ["https://a.example.com", "http://b.example.com", "https://c.example.com"],
  });
  const rows = await runBatch(input, fake);

  assert.equal(rows.length, 3);
  assert.equal(calls.length, 2, "the plaintext origin must never reach the network");
  assert.deepEqual(rows.filter(r => r.outcome === "INVALID_INPUT").map(r => r.reason), ["ORIGIN_NOT_HTTPS"]);
  assert.equal(billableCount(rows), 2);
});

test("the wrapper sends only the origin and the families — nothing else", async () => {
  let sent: Record<string, unknown> = {};
  const fake = (async (_url: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ state: "READY", checks: [{ state: "PASS" }] }), { status: 200 });
  }) as typeof fetch;

  await runBatch(parseBatchInput({
    store_origins: ["https://shop.example.com"], requested_families: ["woo", "robots"],
  }), fake);

  assert.deepEqual(Object.keys(sent).sort(), ["requested_families", "store_origin"]);
});

test("no row carries anything but the origin the caller supplied", async () => {
  const fake = (async () => new Response(JSON.stringify({
    state: "READY",
    checks: [{ id: "woo", state: "PASS", evidence: { safe: true, secret_token: "must-not-appear" } }],
    unknowns: [], observed_at: "2026-09-07T00:00:00.000Z",
    internal_note: "must-not-appear",
  }), { status: 200 })) as typeof fetch;

  const rows = await runBatch(parseBatchInput({ store_origins: ["https://shop.example.com"] }), fake);
  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes("must-not-appear"), false,
    "the row is a projection: unrecognised server fields are dropped, not forwarded");
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "billable", "checks_passed", "checks_total", "http_status", "observed_at",
    "outcome", "reason", "requested_families", "state", "store_origin", "unknowns",
  ]);
});

// -- the authenticated channel, from the Actor's side ----------------------

test("without a credential the Actor sends no channel headers at all", async () => {
  let sent: Record<string, string> = {};
  const fake = (async (_url: string, init?: RequestInit) => {
    sent = Object.fromEntries(new Headers(init?.headers).entries());
    return new Response(JSON.stringify({ state: "READY", checks: [{ state: "PASS" }] }), { status: 200 });
  }) as typeof fetch;

  await runBatch(parseBatchInput({ store_origins: ["https://shop.example.com"] }), fake);
  assert.equal(sent.authorization, undefined);
  assert.equal(sent["x-agentready-run"], undefined);
});

test("with a credential it sends the bearer and a per-origin idempotency key", async () => {
  const seen: Array<Record<string, string>> = [];
  const fake = (async (_url: string, init?: RequestInit) => {
    seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return new Response(JSON.stringify({ state: "READY", checks: [{ state: "PASS" }] }), { status: 200 });
  }) as typeof fetch;

  await runBatch(parseBatchInput({
    store_origins: ["https://a.example.com", "https://b.example.com"], concurrency: 1,
  }), fake, { token: "test-token", runKey: "run-abc123" });

  assert.equal(seen.length, 2);
  for (const headers of seen) {
    assert.equal(headers.authorization, "Bearer test-token");
    assert.equal(headers["x-agentready-run"], "run-abc123");
    assert.match(headers["x-agentready-item"], /^origin-[0-9a-f]{8}$/);
  }
  assert.notEqual(seen[0]["x-agentready-item"], seen[1]["x-agentready-item"],
    "two origins in one run are two items");
});

test("the same origin gets the same item key every time", () => {
  assert.equal(itemKeyFor("https://a.example.com"), itemKeyFor("https://a.example.com"));
  assert.notEqual(itemKeyFor("https://a.example.com"), itemKeyFor("https://b.example.com"));
});

test("an unusable idempotency key is refused rather than silently dropped", () => {
  assert.throws(() => channelHeaders({ token: "t", runKey: "a b", itemKey: "origin-0000ffff" }),
    (e: Error & { code?: string }) => e.code === "IDEMPOTENCY_KEY_UNUSABLE",
    "a key the server would ignore turns a retry into a second call");
});

test("a replayed answer is reported and never billed again", () => {
  const row = toRow("https://a.example.com", null,
    { status: 200, body: { code: "REPLAYED", outcome: "USEFUL", billable: true } });
  assert.equal(row.outcome, "USEFUL");
  assert.equal(row.reason, "REPLAYED");
  assert.equal(row.billable, false, "the first attempt already accounted for this origin");
  assert.equal(billableCount([row]), 0);
});

test("the Actor never puts the credential into a row", async () => {
  const fake = (async () => new Response(JSON.stringify({
    state: "READY", checks: [{ state: "PASS" }],
  }), { status: 200 })) as typeof fetch;
  const rows = await runBatch(parseBatchInput({ store_origins: ["https://a.example.com"] }),
                              fake, { token: "super-secret-token", runKey: "run-1" });
  assert.equal(JSON.stringify(rows).includes("super-secret-token"), false);
});
