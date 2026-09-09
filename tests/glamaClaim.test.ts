import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";

test("Glama ownership proof is exact, public, secured, and independent of D1", async () => {
  const response = await worker.fetch(
    new Request("https://app.utilityhouse.xyz/.well-known/glama.json"),
    {} as never,
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await response.json(), {
    $schema: "https://glama.ai/mcp/schemas/connector.json",
    claim: "glama_claim_SURSLzr6kHLvRUDDcPcTzQp_7C7b_G5H",
  });
});

test("Glama ownership proof is GET-only", async () => {
  const response = await worker.fetch(
    new Request("https://app.utilityhouse.xyz/.well-known/glama.json", { method: "POST" }),
    {} as never,
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "durable financial store is not configured" });
});
