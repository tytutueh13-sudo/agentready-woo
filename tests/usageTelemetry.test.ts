import test from "node:test";
import assert from "node:assert/strict";
import { AppStore } from "../src/core/appStore.ts";
import {
  classifyToolResult, mcpChannelForPath, preflightChannelForPath, usageChannel,
} from "../src/core/usage.ts";
import { sqliteD1 } from "./helpers/sqlite.ts";

test("channel paths label acquisition without changing authorization", () => {
  assert.equal(mcpChannelForPath("/channels/mcp-registry/mcp"), "mcp_registry");
  assert.equal(mcpChannelForPath("/mcp"), null);
  assert.equal(preflightChannelForPath("/channels/rapidapi/preflight"), "rapidapi");
  assert.equal(preflightChannelForPath("/api/v2/preflight"), null);
});

test("only the operations secret can classify an operator probe", () => {
  const secret = "o".repeat(40);
  assert.equal(usageChannel(new Request("https://example.test/mcp"), secret, "direct"), "direct");
  assert.equal(usageChannel(new Request("https://example.test/mcp", {
    headers: { "x-agentready-operator": `Bearer ${secret}` },
  }), secret, "direct"), "operator");
  assert.equal(usageChannel(new Request("https://example.test/mcp", {
    headers: { "x-agentready-operator": "Bearer wrong" },
  }), secret, "mcp_registry"), "mcp_registry");
});

test("tool outcomes distinguish answers, abstentions, replays and failures", () => {
  assert.equal(classifyToolResult(true, JSON.stringify({ state: "ACCEPTED" })), "answered");
  assert.equal(classifyToolResult(true, JSON.stringify({ state: "BLOCKED" })), "abstained");
  assert.equal(classifyToolResult(true, JSON.stringify({ delivery: "REPLAY" })), "replay");
  assert.equal(classifyToolResult(false, JSON.stringify({ code: "INVALID_INPUT" })), "invalid");
  assert.equal(classifyToolResult(false, JSON.stringify({ code: "AUTH_REQUIRED" })), "refused");
  assert.equal(classifyToolResult(false, JSON.stringify({ code: "WORKFLOW_UNAVAILABLE" })), "internal_error");
});

test("canonical usage ledger stores finite aggregates and no caller data", async () => {
  const { db } = sqliteD1();
  const app = new AppStore(db);
  const beforeMidnight = Date.parse("2026-09-08T14:59:59Z");
  const afterMidnight = Date.parse("2026-09-08T15:00:01Z");
  await app.recordSurfaceUsage("mcp", "preflight_woo_store", "mcp_registry", "answered", beforeMidnight);
  await app.recordSurfaceUsage("mcp", "preflight_woo_store", "mcp_registry", "answered", beforeMidnight);
  await app.recordSurfaceUsage("rest_preflight", "preflight_woo_store", "rapidapi", "abstained", afterMidnight);
  const rows = await app.surfaceUsageSummary("2026-09-08");
  assert.deepEqual(rows, [
    { kst_date: "2026-09-08", surface: "mcp", operation: "preflight_woo_store", channel: "mcp_registry", outcome: "answered", calls: 2 },
    { kst_date: "2026-09-09", surface: "rest_preflight", operation: "preflight_woo_store", channel: "rapidapi", outcome: "abstained", calls: 1 },
  ]);
  const columns = await db.prepare("PRAGMA table_info(agentready_surface_usage_daily)").all<{ name: string }>();
  assert.deepEqual(columns.results.map(row => row.name), [
    "kst_date", "surface", "operation", "channel", "outcome", "calls", "updated_at",
  ]);
  await assert.rejects(
    () => app.recordSurfaceUsage("mcp", "https://shop.example/private", "direct", "answered"),
    /invalid aggregate usage label/,
  );
});
