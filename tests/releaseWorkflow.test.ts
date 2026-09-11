import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const workflow = readFileSync(resolve(process.cwd(), "..", "..", ".github", "workflows", "agentwoo-release.yml"), "utf8");

test("AgentWoo deployment uses its own least-privilege credential and explicit account", () => {
  assert.match(workflow, /secrets\.AGENTWOO_DEPLOY_API_TOKEN/);
  assert.match(workflow, /vars\.CLOUDFLARE_ACCOUNT_ID/);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(workflow, /[0-9a-f]{32}/);
  assert.doesNotMatch(workflow, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
});

test("AgentWoo fails before upload when deployment configuration is missing", () => {
  assert.match(workflow, /name: Check AgentWoo deployment configuration[\s\S]*?run: \|\n\s+node -e/);
  assert.ok(workflow.indexOf("Check AgentWoo deployment configuration") < workflow.indexOf("wrangler versions upload"));
  assert.doesNotMatch(workflow, /echo .*CLOUDFLARE_(?:API_TOKEN|ACCOUNT_ID)|printenv|env \|/);
});

test("AgentWoo uses action releases that run natively on the current GitHub runtime", () => {
  assert.match(workflow, /actions\/checkout@v7/);
  assert.match(workflow, /actions\/setup-node@v7/);
  assert.doesNotMatch(workflow, /actions\/(?:checkout|setup-node)@v4/);
});
