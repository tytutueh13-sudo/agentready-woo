#!/usr/bin/env node

const base = (process.argv[2] || "https://app.utilityhouse.xyz").replace(/\/$/, "");
const token = (process.env.AGENTREADY_OPS_TOKEN || "").trim();
if (token.length < 32) throw new Error("AGENTREADY_OPS_TOKEN is required for an operator smoke call");

const response = await fetch(`${base}/ops/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "scan_woo_store_readiness", arguments: { demo: true } },
  }),
});
if (!response.ok) throw new Error(`operator smoke returned ${response.status}`);
const body = await response.json();
const text = body?.result?.content?.[0]?.text;
const result = JSON.parse(String(text || "{}"));
if (result.state !== "SCORED" || result.evidence_status !== "SYNTHETIC_DEMO") {
  throw new Error("operator smoke did not return the deterministic demo");
}
console.log(JSON.stringify({ status: "PASS", route: "/ops/mcp", telemetry: "operator" }));
