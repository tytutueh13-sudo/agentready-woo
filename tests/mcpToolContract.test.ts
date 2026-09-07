// The root /mcp surface shipped to production advertising a single tool whose
// entire argument contract was `{ action: { type: "string" } }` with no enum,
// and whose description was the product's marketing blurb rather than what the
// tool answers. An agent reading that list has no way to construct a valid
// call — which is a complete outage of the tool surface that every health
// check still reports as green, because the server is up and answering.
//
// These tests pin the contract itself, not the transport.
import test from "node:test";
import assert from "node:assert/strict";
import { TOOL_DESCRIPTION, TOOL_INPUT_SCHEMA, SERVER_DESCRIPTION, TOOL_NAME } from "../src/mcp.ts";
import { SUPPORTED_ACTIONS } from "../src/service.ts";
import { storeMcpTools } from "../src/app.ts";
import type { ServiceConfig } from "../src/service.ts";

function schemaActions(): string[] {
  const props = TOOL_INPUT_SCHEMA.properties as Record<string, { enum?: string[] }>;
  return props.action?.enum ?? [];
}

test("the advertised actions are exactly the ones runTool dispatches on", () => {
  // Not a subset check on purpose: an action the service handles but never
  // advertises is invisible to every agent, and an action advertised but not
  // handled is a promise the tool breaks at call time.
  assert.deepEqual(
    [...schemaActions()].sort(),
    [...SUPPORTED_ACTIONS].sort(),
    "TOOL_INPUT_SCHEMA's action enum must track SUPPORTED_ACTIONS",
  );
});

test("action is a closed enum, not a free-form string", () => {
  const actions = schemaActions();
  assert.ok(actions.length > 0, "action must carry an enum — a bare string tells an agent nothing");
  assert.equal((TOOL_INPUT_SCHEMA.required as string[])[0], "action");
});

test("every argument the actions need is declared, not left to guesswork", () => {
  const props = TOOL_INPUT_SCHEMA.properties as Record<string, unknown>;
  // Each of these is read by runTool(); an agent cannot supply what the schema
  // never mentions.
  for (const field of ["query", "product_id", "quantity", "page", "per_page", "cart_url"]) {
    assert.ok(field in props, `${field} is read by runTool but missing from the schema`);
  }
});

test("the tool description says when to call it, not what was built", () => {
  // The regression in production: the tool description opened with
  // "A deploy-once Cloudflare Worker + MCP server that connects to..." — an
  // architecture summary. A model choosing tools cannot act on that.
  assert.ok(
    !/deploy-once|Cloudflare Worker|dashboard showing/i.test(TOOL_DESCRIPTION),
    "tool description must not be the product/architecture blurb",
  );
  for (const action of SUPPORTED_ACTIONS) {
    assert.ok(
      TOOL_DESCRIPTION.includes(action),
      `the description should name ${action} so a model knows the tool covers it`,
    );
  }
});

test("the server blurb and the tool description are separate things", () => {
  assert.notEqual(
    TOOL_DESCRIPTION, SERVER_DESCRIPTION,
    "reusing one string for both is how the tool surface became unusable",
  );
});

test("the per-store surface serves the same contract as the root", () => {
  // These two drifted: app.ts had the good contract, the root had the opaque
  // one, and only the root was in the registry.
  const config: ServiceConfig = {
    storeUrl: "https://shop.example.com", consumerKey: "ck", consumerSecret: "cs",
    cartSigningSecret: "s".repeat(32), publicBaseUrl: "https://app.example.com",
  };
  const tool = storeMcpTools({ plan: "free" }, config).find(t => t.name === TOOL_NAME);
  assert.ok(tool, "the catalogue tool must stay on the list");
  assert.equal(tool.description, TOOL_DESCRIPTION);
  assert.deepEqual(tool.inputSchema, TOOL_INPUT_SCHEMA);
});
