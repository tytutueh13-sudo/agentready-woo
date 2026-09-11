// Every one of these failed silently in the wild at least once, on this product
// or on a sibling: a registry record that still advertises last month's version,
// two manifests that disagree about the name, a marketing page quoting a tool
// count nobody re-counted, and a price attached to a route that cannot settle.
//
// None of them breaks a health check. All of them are visible to a reviewer.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { AGENTREADY_PUBLIC_NAME, AGENTREADY_VERSION } from "../src/productIdentity.ts";
import { publicScanMcpTool, PUBLIC_SCAN_TOOL_NAME } from "../src/publicScanMcp.ts";
import { releaseGateMcpTools } from "../src/releaseGate/mcpTools.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CANONICAL_ORIGIN = "https://app.utilityhouse.xyz";

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(ROOT, path), "utf8")) as Record<string, unknown>;
}
function text(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** The tool inventory the deployed server advertises, assembled the same way
 * the Worker assembles it: two public tools, three owner-authorized ones. */
function advertisedTools(): string[] {
  const authenticated = {
    app: {} as never,
    workflow: undefined,
  };
  const gate = releaseGateMcpTools({}, authenticated as never).map(t => t.name);
  return [PUBLIC_SCAN_TOOL_NAME, ...gate];
}

// -- manifests must agree with the code ------------------------------------

test("every manifest carries the same version the code reports", () => {
  for (const path of ["server.json", "mcp-registry/server.json"]) {
    assert.equal(json(path).version, AGENTREADY_VERSION,
      `${path} advertises a version the running server does not report`);
  }
});

test("the public package, Action and WordPress plugin carry their release versions", () => {
  assert.equal(json("package.json").version, AGENTREADY_VERSION);
  assert.match(text("action/index.mjs"), new RegExp(`agentready-woo-action/${AGENTREADY_VERSION.replaceAll(".", "\\.")}`));
  assert.match(text("wordpress-plugin/utilityhouse-release-gate-for-woocommerce/utilityhouse-release-gate-for-woocommerce.php"),
    /Version:\s+1\.2\.1/);
});

test("the two server manifests are the same document", () => {
  assert.deepEqual(json("server.json"), json("mcp-registry/server.json"),
    "one of these gets published and the other gets read; they cannot differ");
});

test("the registry manifest carries only fields the registry schema allows", () => {
  // Checked against the 2025-12-11 schema on 2026-09-07. The previous manifest
  // carried display_name, repositories, publisher, keywords, license and
  // transport — none of which the schema defines, so publishing it would have
  // dropped or rejected them.
  const allowed = new Set([
    "$schema", "_meta", "description", "icons", "name", "packages",
    "remotes", "repository", "title", "version", "websiteUrl",
  ]);
  const manifest = json("mcp-registry/server.json");
  const extra = Object.keys(manifest).filter(k => !allowed.has(k));
  assert.deepEqual(extra, [], `not in the registry schema: ${extra.join(", ")}`);
  for (const required of ["name", "description", "version"]) {
    assert.ok(manifest[required], `${required} is required by the registry schema`);
  }
});

test("every manifest points at the canonical origin", () => {
  for (const path of ["server.json", "mcp-registry/server.json"]) {
    const remotes = json(path).remotes as Array<{ url: string }>;
    assert.equal(remotes.length, 1);
    assert.equal(remotes[0].url, `${CANONICAL_ORIGIN}/mcp`,
      `${path} must advertise the canonical readiness surface, not a store-bound URL`);
  }
});

test("the manifest title matches the product's public name", () => {
  assert.equal(json("server.json").title, AGENTREADY_PUBLIC_NAME);
});

// -- the tool surface -------------------------------------------------------

test("the product advertises five tools, two public and three authorized", () => {
  const tools = advertisedTools();
  assert.equal(tools.length, 5, "a changed tool count invalidates every listing");
  assert.deepEqual(tools, [
    "scan_woo_store_readiness",
    "preflight_woo_store",
    "start_woo_release_verification",
    "get_woo_release_verification",
    "claim_woo_release_result",
  ]);
});

test("every advertised tool declares annotations, because directories read them", () => {
  const gate = releaseGateMcpTools({}, { app: {} as never, workflow: undefined } as never);
  const all = [publicScanMcpTool(fetch), ...gate];
  for (const tool of all) {
    assert.ok(tool.annotations, `${tool.name} ships without annotations`);
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", tool.name);
    assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} must not be destructive`);
  }
});

test("every advertised output schema has the MCP-compatible object root Smithery requires", () => {
  const gate = releaseGateMcpTools({}, { app: {} as never, workflow: undefined } as never);
  const all = [publicScanMcpTool(fetch), ...gate];
  for (const tool of all) {
    if (tool.outputSchema) {
      assert.equal(
        (tool.outputSchema as { type?: unknown }).type,
        "object",
        `${tool.name} must advertise an object-root output schema`,
      );
    }
  }
});

test("every advertised input property tells a model exactly what belongs there", () => {
  const gate = releaseGateMcpTools({}, { app: {} as never, workflow: undefined } as never);
  const all = [publicScanMcpTool(fetch), ...gate];
  for (const tool of all) {
    const schema = tool.inputSchema as {
      properties?: Record<string, { type?: unknown; const?: unknown; description?: unknown }>;
    };
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      assert.equal(typeof property.description, "string", `${tool.name}.${name} needs a description`);
      assert.ok(String(property.description).length >= 24, `${tool.name}.${name} description is too thin`);
      if (property.const !== undefined) {
        assert.equal(typeof property.type, "string", `${tool.name}.${name} const must still declare its JSON type`);
      }
    }
  }
});

test("a tool that writes does not claim to be read-only", () => {
  const gate = releaseGateMcpTools({}, { app: {} as never, workflow: undefined } as never);
  const byName = new Map(gate.map(t => [t.name, t]));
  // start and claim change state; get does not.
  assert.equal(byName.get("start_woo_release_verification")?.annotations?.readOnlyHint, false);
  assert.equal(byName.get("claim_woo_release_result")?.annotations?.readOnlyHint, false);
  assert.equal(byName.get("get_woo_release_verification")?.annotations?.readOnlyHint, true);
  assert.equal(publicScanMcpTool(fetch).annotations?.readOnlyHint, true);
});

// -- the public page cannot outrun the product -----------------------------

const LANDING = "marketing/landing/index.html";
const COMMERCE = "marketing/landing/commerce.html";

test("the internal product manifest describes the current Release Gate product", () => {
  const manifest = json("product.json");
  assert.match(String(manifest.description), /passive public WooCommerce preflight/i);
  assert.match(String(manifest.description), /settlement is currently disabled/i);
  assert.doesNotMatch(String(manifest.description), /top-25-product feed|create signed cart links/i);
});

test("the free scan is never described as paid", () => {
  const page = text(LANDING);
  assert.equal(/free (passive )?(store )?preflight/i.test(page), true,
    "the free path must still be described as free");
  // no price may sit adjacent to the public scan or preflight CTA
  const ctaRegion = page.slice(0, page.indexOf("Priced like a WooCommerce plugin"));
  assert.equal(/preflight[^<]{0,60}\$\d/i.test(ctaRegion), false,
    "a price next to the free preflight is the phantom-checkout failure");
});

test("no plan is presented as Release Gate entitlement", () => {
  const commerce = text(COMMERCE);
  assert.match(commerce, /Commerce plans do not include or imply Release Gate entitlement/i,
    "the separate commerce surface must explicitly deny Release Gate entitlement");
});

test("the Release Gate root carries no purchasable price while settlement is disabled", () => {
  const page = text(LANDING);
  assert.equal(/\$\d[\d,.]*/.test(page), false);
  assert.match(page, /Release Gate settlement remains disabled/i);
});

test("the stale one-tool and non-JSON-RPC claims have not come back", () => {
  const page = text(LANDING);
  assert.equal(/single tool|one tool|only tool/i.test(page), false);
  assert.equal(/not json-?rpc|is not a json-?rpc/i.test(page), false);
});

test("no page claims measured accuracy, customers or revenue", () => {
  const page = text(LANDING);
  for (const forbidden of [
    /\d+\s*%\s*accurate/i,
    /accuracy of \d/i,
    /\b\d[\d,]*\s+(merchants|customers|stores) (?:use|trust|rely)/i,
    /\$[\d,]+\s*(?:in\s*)?(?:revenue|MRR|ARR)/i,
    /guaranteed?\s+(?:results|visibility|ranking)/i,
  ]) {
    assert.equal(forbidden.test(page), false, `unsupported claim shape: ${forbidden}`);
  }
});

test("the Adobe conversion figure appears at most once, and next to its source", () => {
  // It was on the page twice with two different numbers, from the same source
  // in the same month. One instance, beside the source links, or none.
  const page = text(LANDING);
  const hits = [...page.matchAll(/\+\d{1,3}%?<\/?[^>]*>?\s*higher conversion|higher conversion from AI-referred/gi)];
  assert.ok(hits.length <= 1, `the conversion claim appears ${hits.length} times; it may appear once`);
  if (hits.length === 1) {
    assert.match(page, /Adobe/i, "the figure must sit with its attribution");
  }
});

// -- the Apify wrapper stays a wrapper -------------------------------------

test("the Apify Actor contains no scoring logic of its own", () => {
  const batch = text("integrations/apify-batch-preflight/batch.ts");
  for (const forbidden of [/\bscore\b\s*=/, /weight\s*\*/, /grade\s*=/, /readinessScore/]) {
    assert.equal(forbidden.test(batch), false,
      `the wrapper must delegate scoring to the ProductCore: ${forbidden}`);
  }
  assert.match(batch, /api\/v2\/preflight/, "it must call the canonical route");
});

test("the Apify Actor never reaches an owner-authorized tool", () => {
  const files = ["integrations/apify-batch-preflight/batch.ts", "integrations/apify-batch-preflight/main.ts"];
  for (const file of files) {
    const source = text(file);
    for (const authorized of [
      "start_woo_release_verification", "get_woo_release_verification",
      "claim_woo_release_result", "acceptance-runs", "Authorization",
    ]) {
      // the words may appear in a comment explaining the exclusion; a call may not
      const calls = new RegExp(`(?:fetch|await)[^\\n]{0,120}${authorized}`);
      assert.equal(calls.test(source), false, `${file} must not call ${authorized}`);
    }
  }
});

test("paid activation is off, and the charged event is defined anyway", () => {
  const main = text("integrations/apify-batch-preflight/main.ts");
  assert.match(main, /PAID_ACTIVATION\s*=\s*false/,
    "settlement is disabled for this product; the Actor may not charge");
  assert.match(main, /CHARGED_EVENT\s*=\s*"preflight-answered"/,
    "the event boundary is defined so activation is a decision, not a redesign");
});

// -- the pages three marketplaces require ----------------------------------

test("support and security pages exist and say what they must", () => {
  const support = text("marketing/landing/support.html");
  const security = text("marketing/landing/security.html");

  // OpenAI, RapidAPI and the Connectors Directory all require a support URL.
  assert.match(support, /hello@utilityhouse\.xyz/, "the support page must carry the address");
  assert.match(support, /do not publish a response time/i,
    "no SLA may be promised, because none has been measured");
  // the page quotes "within 24 hours" as the thing it refuses to say, so the
  // check looks for an actual commitment, not the illustration of one
  assert.equal(/we (respond|reply|answer)[^.]{0,60}within \d+/i.test(support), false,
    "a response-time promise crept in");
  for (const mustRefuse of [/consumer keys/i, /passwords/i, /customer names/i]) {
    assert.match(support, mustRefuse, "the page must tell people what never to send");
  }

  assert.match(security, /aggregate/i, "the plugin's evidence boundary must be stated");
  assert.match(security, /settlement is <strong>disabled<\/strong>|settlement is disabled/i);
  assert.match(security, /unmeasured/i, "the accuracy limit must be stated, not hidden");
  assert.equal(/certified|certification (is )?(granted|held)|ISO ?27001|SOC ?2/i.test(security), false,
    "no certification may be claimed");
  assert.match(security, /hello@utilityhouse\.xyz/, "a reporting route is required");
});

test("every policy page reaches support and security", () => {
  for (const page of ["index.html", "privacy.html", "terms.html", "refund-policy.html",
                      "support.html", "security.html"]) {
    const html = text(`marketing/landing/${page}`);
    assert.match(html, /href="\/support"/, `${page} does not link support`);
    assert.match(html, /href="\/security"/, `${page} does not link security`);
  }
});

test("retired pricing anchors point to the separate commerce surface", () => {
  for (const page of ["privacy.html", "terms.html", "refund-policy.html"]) {
    const html = text(`marketing/landing/${page}`);
    assert.equal(html.includes('/#pricing'), false, `${page} still points at the removed pricing section`);
    assert.match(html, /href="\/commerce">Commerce plans<\/a>/,
      `${page} must route account-product pricing away from the Release Gate root`);
  }
});

test("the favicon.ico that was 404ing is now shipped", () => {
  const ico = join(ROOT, "marketing/landing/favicon.ico");
  assert.ok(statSync(ico).size > 0, "favicon.ico must exist — it was a console 404");
  assert.match(text("marketing/landing/index.html"), /href="\/favicon\.ico"/);
});

test("link text on the new pages clears AA on this paper", () => {
  // #E4572E is 3.5:1 on #FAF9F5 — below AA for body text. Measured, then fixed.
  for (const page of ["support.html", "security.html"]) {
    const html = text(`marketing/landing/${page}`);
    assert.match(html, /a\{color:#C43F1B\}/,
      `${page} must not set link text to the 3.5:1 accent`);
  }
});
