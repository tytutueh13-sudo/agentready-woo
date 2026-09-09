import test from "node:test";
import assert from "node:assert/strict";
import { decisionFor, parseInputs, runAction } from "../action/index.mjs";

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
