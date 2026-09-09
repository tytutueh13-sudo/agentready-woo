import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { sqliteD1 } from "./helpers/sqlite.ts";

function request(token?: string): Request {
  return new Request("https://worker.example/ops/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "scan_woo_store_readiness", arguments: { demo: true } },
    }),
  });
}

test("operator smoke calls never increase direct demand", async () => {
  const token = "o".repeat(40);
  const { db, raw } = sqliteD1();
  const response = await worker.fetch(request(token), {
    FINANCIAL_DB: db, OPS_TOKEN: token, REVENUE_SYSTEM_ENABLED: "true",
    PUBLIC_BASE_URL: "https://worker.example", APP_ENCRYPTION_SECRET: "a".repeat(48),
    CART_SIGNING_SECRET: "c".repeat(48),
  } as never);
  assert.equal(response.status, 200);
  const rows = raw.prepare(
    "SELECT channel,outcome,calls FROM agentready_surface_usage_daily ORDER BY channel",
  ).all() as Array<{ channel: string; outcome: string; calls: number }>;
  assert.deepEqual(rows.map(row => ({ ...row })),
    [{ channel: "operator", outcome: "answered", calls: 1 }]);
});

test("operator path fails closed when the secret is missing or wrong", async () => {
  for (const [configured, supplied, status] of [
    [undefined, undefined, 503],
    ["o".repeat(40), undefined, 401],
    ["o".repeat(40), "wrong", 401],
  ] as const) {
    const { db } = sqliteD1();
    const response = await worker.fetch(request(supplied), {
      FINANCIAL_DB: db, OPS_TOKEN: configured, REVENUE_SYSTEM_ENABLED: "true",
      PUBLIC_BASE_URL: "https://worker.example", APP_ENCRYPTION_SECRET: "a".repeat(48),
      CART_SIGNING_SECRET: "c".repeat(48),
    } as never);
    assert.equal(response.status, status);
  }
});
