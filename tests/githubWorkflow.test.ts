import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(ROOT, ".github/workflows/action-smoke.yml"), "utf8");

test("the public smoke invokes the Marketplace major tag without privileged access", () => {
  assert.match(workflow, /uses: tytutueh13-sudo\/agentready-woo@v1/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(workflow, /secrets\.|contents: write|pull-requests: write/);
});

test("the smoke scans only our first-party origin and accepts finite abstention output", () => {
  assert.match(workflow, /store-origin: https:\/\/app\.utilityhouse\.xyz/);
  assert.match(workflow, /fail-on-hold: "false"/);
  assert.match(workflow, /RELEASE\|HOLD\|PARTIAL\|ABSTAIN/);
  assert.match(workflow, /ACCEPTED\|REJECTED\|PARTIAL\|BLOCKED\|UNMEASURED/);
});
