#!/usr/bin/env node

const base = (process.argv[2] || "https://app.utilityhouse.xyz").replace(/\/$/, "");
const expectedTools = [
  "scan_woo_store_readiness",
  "preflight_woo_store",
  "start_woo_release_verification",
  "get_woo_release_verification",
  "claim_woo_release_result",
];

function ok(condition, message) {
  if (!condition) throw new Error(message);
}

async function get(path) {
  const response = await fetch(`${base}${path}`, { redirect: "manual" });
  ok(response.status === 200, `${path}: expected 200, got ${response.status}`);
  return response;
}

for (const path of ["/", "/health", "/status", "/support", "/security",
                    "/robots.txt", "/llms.txt", "/.well-known/agenticweb.md",
                    "/downloads/agentready-woo.zip"]) {
  const response = await get(path);
  for (const header of ["content-security-policy", "strict-transport-security",
                        "x-content-type-options", "referrer-policy"]) {
    ok(response.headers.has(header), `${path}: missing ${header}`);
  }
}

const health = await (await get("/health")).json();
ok(health.status === "healthy", "health is not healthy");
ok(health.version === "1.1.0", `unexpected health version ${health.version}`);
ok(typeof health.artifactHash === "string" && health.artifactHash.length > 0,
  "health does not expose a Cloudflare deployment identity");

const rpc = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { "content-type": "application/json", "accept": "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
});
ok(rpc.status === 200, `tools/list: expected 200, got ${rpc.status}`);
const payload = await rpc.json();
const tools = payload?.result?.tools;
ok(Array.isArray(tools), "tools/list did not return a tools array");
ok(JSON.stringify(tools.map(tool => tool.name)) === JSON.stringify(expectedTools),
  `unexpected root tools: ${JSON.stringify(tools.map(tool => tool.name))}`);
const preflight = tools.find(tool => tool.name === "preflight_woo_store");
ok(preflight?.annotations?.readOnlyHint === true, "preflight read-only annotation missing");
ok(preflight?.outputSchema?.type === "object", "preflight outputSchema missing");

const [robots, llms, agentic] = await Promise.all([
  (await get("/robots.txt")).text(),
  (await get("/llms.txt")).text(),
  (await get("/.well-known/agenticweb.md")).text(),
]);
ok(/User-agent: \*\s+Allow: \//.test(robots), "public indexing is not enabled");
for (const tool of expectedTools) {
  ok(llms.includes(tool) && agentic.includes(tool), `${tool} missing from discovery documents`);
}
const settlementDisabled = /settlement is\s+(?:currently\s+)?disabled/i;
ok(settlementDisabled.test(llms), "llms.txt does not disclose disabled settlement");
ok(settlementDisabled.test(agentic), "agenticweb does not disclose disabled settlement");

console.log(JSON.stringify({ status: "PASS", base, version: health.version,
  artifactHash: health.artifactHash, rootTools: expectedTools.length }));
