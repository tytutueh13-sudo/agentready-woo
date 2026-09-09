import test from "node:test";
import assert from "node:assert/strict";
import { PUBLIC_SCAN_TOOL_DESCRIPTION } from "../src/publicScanMcp.ts";
import { releaseGateMcpTools } from "../src/releaseGate/mcpTools.ts";

type Tool = "scan_woo_store_readiness" | "preflight_woo_store";

const cases: Array<[Tool, string]> = [
  ["scan_woo_store_readiness", "Give this shop a general agent-readiness score."],
  ["scan_woo_store_readiness", "Can shopping agents read my WooCommerce storefront?"],
  ["scan_woo_store_readiness", "Audit my store and recommend what to fix."],
  ["scan_woo_store_readiness", "Why is my product catalogue hard for agents to read?"],
  ["scan_woo_store_readiness", "Check my public store's structured product data."],
  ["scan_woo_store_readiness", "Run the free store readiness scan."],
  ["scan_woo_store_readiness", "Score my agent discovery setup."],
  ["scan_woo_store_readiness", "Show readiness recommendations for this store."],
  ["scan_woo_store_readiness", "Is the public Store API readable?"],
  ["scan_woo_store_readiness", "Assess catalogue accessibility without changing anything."],
  ["scan_woo_store_readiness", "Which agent-readiness checks fail on my shop?"],
  ["scan_woo_store_readiness", "I want a broad Woo store audit, not a release check."],
  ["scan_woo_store_readiness", "Demonstrate a synthetic readiness result."],
  ["scan_woo_store_readiness", "What should I improve so agents can understand my products?"],
  ["scan_woo_store_readiness", "Evaluate my public storefront and give me a grade."],
  ["preflight_woo_store", "Preflight this exact WooCommerce update before release."],
  ["preflight_woo_store", "Did MCP survive the plugin update I am about to ship?"],
  ["preflight_woo_store", "Check woo, robots and jsonld before today's deployment."],
  ["preflight_woo_store", "I need protocol-family evidence for a release decision."],
  ["preflight_woo_store", "Verify public agent protocols before upgrading WooCommerce."],
  ["preflight_woo_store", "Run a version-pinned release preflight."],
  ["preflight_woo_store", "Should this update proceed to the owner-authorized gate?"],
  ["preflight_woo_store", "Check MCP, UCP and ACP surfaces before deploy."],
  ["preflight_woo_store", "Inspect release protocol evidence, not a general score."],
  ["preflight_woo_store", "What changed in the agent-facing surface after this update?"],
  ["preflight_woo_store", "Test selected protocol families before I publish the release."],
  ["preflight_woo_store", "Run the read-only check in my update pipeline."],
  ["preflight_woo_store", "Pre-deployment evidence for this Woo version please."],
  ["preflight_woo_store", "Is the upcoming plugin release compatible with agent surfaces?"],
  ["preflight_woo_store", "I need PASS, FAIL or UNMEASURED by protocol family."],
];

function contractSelect(prompt: string): Tool | null {
  const p = prompt.toLowerCase();
  const release = /(release|update|upgrade|deploy|deployment|version|pipeline|protocol|mcp|ucp|acp|family|compatible)/.test(p);
  const general = /(general|broad|score|grade|recommend|improve|audit|readiness|catalogue|store api|structured product|discovery|shopping agents read|storefront|understand my products)/.test(p);
  if (release && !general) return "preflight_woo_store";
  if (general && !release) return "scan_woo_store_readiness";
  if (p.includes("not a release check")) return "scan_woo_store_readiness";
  if (p.includes("not a general score")) return "preflight_woo_store";
  if (p.includes("before") && release) return "preflight_woo_store";
  return null;
}

test("thirty public-tool prompts select the intended non-overlapping job", () => {
  assert.equal(cases.length, 30);
  for (const [expected, prompt] of cases) assert.equal(contractSelect(prompt), expected, prompt);
});

test("ambiguous requests are escalated instead of guessed", () => {
  for (const prompt of [
    "Check my Woo store.",
    "Can you help with AgentReady?",
    "Run something against example.com.",
  ]) assert.equal(contractSelect(prompt), null, prompt);
});

test("the live descriptions state both positive and negative selection rules", () => {
  const preflight = releaseGateMcpTools()[0].description;
  assert.match(PUBLIC_SCAN_TOOL_DESCRIPTION, /ONLY.*general storefront audit/i);
  assert.match(PUBLIC_SCAN_TOOL_DESCRIPTION, /Do NOT.*specific update or release/i);
  assert.match(preflight, /ONLY.*specific WooCommerce update or release/i);
  assert.match(preflight, /Do NOT.*general score or fix list/i);
});
