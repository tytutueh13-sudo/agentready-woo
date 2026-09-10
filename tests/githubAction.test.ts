import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decisionFor, parseInputs, runAction } from "../action/index.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const actionPath = fileURLToPath(new URL("../action/index.mjs", import.meta.url));

test("the published action declares the supported Node 24 runtime", () => {
  const metadata = readFileSync(join(root, "action.yml"), "utf8");
  assert.match(metadata, /runs:\s*\n\s*using: node24\s*\n\s*main: action\/index\.mjs/);
  assert.doesNotMatch(metadata, /using: node20/);
});

test("GitHub Actions environment does not execute the action when the module is imported", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", `await import(${JSON.stringify(new URL("../action/index.mjs", import.meta.url).href)})`], {
    env: { ...process.env, GITHUB_ACTIONS: "true" },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
});

test("direct GitHub Action invocation still executes and fails closed without required input", () => {
  const result = spawnSync(process.execPath, [actionPath], {
    env: { ...process.env, GITHUB_ACTIONS: "true", "INPUT_STORE-ORIGIN": "" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::store-origin must be a public HTTPS origin/);
});

test("action inputs accept only an origin and the closed family set", () => {
  assert.deepEqual(parseInputs({
    "INPUT_STORE-ORIGIN": "https://shop.example/", INPUT_FAMILIES: "woo,mcp,woo",
  }), { origin: "https://shop.example", families: ["woo", "mcp"], failOnHold: true });
  for (const bad of ["http://shop.example", "https://user:pass@shop.example", "https://shop.example/path"]) {
    assert.throws(() => parseInputs({ "INPUT_STORE-ORIGIN": bad }));
  }
  assert.throws(() => parseInputs({ "INPUT_STORE-ORIGIN": "https://shop.example", INPUT_FAMILIES: "woo,payment" }));
});

test("only an explicit rejected result becomes HOLD", () => {
  assert.equal(decisionFor("ACCEPTED"), "RELEASE");
  assert.equal(decisionFor("REJECTED"), "HOLD");
  assert.equal(decisionFor("PARTIAL"), "PARTIAL");
  assert.equal(decisionFor("BLOCKED"), "ABSTAIN");
  assert.equal(decisionFor("UNMEASURED"), "ABSTAIN");
});

test("action writes finite outputs and keeps an abstention green", async () => {
  const writes: Array<[string, string]> = [];
  const result = await runAction({
    env: { "INPUT_STORE-ORIGIN": "https://shop.example", GITHUB_OUTPUT: "out", GITHUB_STEP_SUMMARY: "summary" },
    fetchImpl: async () => new Response(JSON.stringify({
      state: "BLOCKED", observed_at: "2026-09-10T00:00:00Z", unknowns: ["ROBOTS_BLOCKED"],
      checks: [{ family: "robots", state: "BLOCKED", reasonCode: "ROBOTS_BLOCKED" }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
    append: async (path: string, body: string) => { writes.push([path, String(body)]); },
  });
  assert.equal(result.decision, "ABSTAIN");
  assert.match(writes.find(([path]) => path === "out")?.[1] ?? "", /decision=ABSTAIN/);
  assert.match(writes.find(([path]) => path === "summary")?.[1] ?? "", /ROBOTS_BLOCKED/);
});

test("action fails only when configured to fail on HOLD", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ state: "REJECTED", checks: [] }), { status: 200 });
  await assert.rejects(() => runAction({ env: { "INPUT_STORE-ORIGIN": "https://shop.example" }, fetchImpl, append: async () => {} }), /HOLD/);
  const result = await runAction({ env: { "INPUT_STORE-ORIGIN": "https://shop.example", "INPUT_FAIL-ON-HOLD": "false" }, fetchImpl, append: async () => {} });
  assert.equal(result.decision, "HOLD");
});
