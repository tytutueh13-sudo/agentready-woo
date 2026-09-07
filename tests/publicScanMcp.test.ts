import test from "node:test";
import assert from "node:assert/strict";
import {
  PUBLIC_SCAN_INPUT_SCHEMA, PUBLIC_SCAN_TOOL_NAME, publicScanMcpTool, runPublicScan,
} from "../src/publicScanMcp.ts";

const fakeFetch = (async (input: string | URL) => {
  const url = new URL(String(input));
  if (url.pathname === "/wp-json/wc/store/v1/products") {
    return new Response(JSON.stringify([{
      id: 1, name: "Person Name Should Not Escape", status: "publish",
      prices: { price: "1000" }, stock_status: "instock",
      description: "private-looking product prose that must not escape",
      images: [{ src: "https://shop.example.com/a.jpg" }],
    }]), { status: 200 });
  }
  if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /", { status: 200 });
  if (url.pathname === "/.well-known/agenticweb.md") return new Response("ready", { status: 200 });
  return new Response("<title>Private Shop Name</title>WooCommerce", { status: 200 });
}) as typeof fetch;

test("the public tool has explicit live-scan and synthetic-demo inputs", () => {
  assert.equal(PUBLIC_SCAN_TOOL_NAME, "scan_woo_store_readiness");
  assert.equal(Array.isArray(PUBLIC_SCAN_INPUT_SCHEMA.oneOf), true);
  assert.equal((PUBLIC_SCAN_INPUT_SCHEMA.properties as Record<string, unknown>).store_url !== undefined, true);
  assert.equal((PUBLIC_SCAN_INPUT_SCHEMA.properties as Record<string, unknown>).demo !== undefined, true);
  assert.equal(PUBLIC_SCAN_INPUT_SCHEMA.additionalProperties, false);
});

test("the public demo is deterministic, free, and explicitly synthetic", async () => {
  const first = await runPublicScan({ demo: true });
  const second = await runPublicScan({ demo: true });
  assert.deepEqual(first, second);
  assert.equal(first.billable, false);
  assert.equal(first.evidence_status, "SYNTHETIC_DEMO");
  assert.equal(first.scanned_at, 0);
});

test("the public scan emits aggregates but no store or product text", async () => {
  const result = await runPublicScan({ store_url: "https://shop.example.com" }, fakeFetch);
  const text = JSON.stringify(result);
  assert.equal(result.billable, false);
  assert.equal(result.evidence_status, "LIVE_PUBLIC_SCAN");
  assert.doesNotMatch(text, /shop\.example|Private Shop|Person Name|product prose|a\.jpg/);
  assert.equal(result.product_count_sampled, 1);
});

test("the public tool fails closed on extra arguments and private targets", async () => {
  for (const args of [
    { store_url: "https://shop.example.com", consumer_secret: "x" },
    { store_url: "https://127.0.0.1" },
    { store_url: "https://shop.example.com", demo: true },
  ]) {
    const out = await publicScanMcpTool(fakeFetch).run(args);
    assert.equal(out.ok, false);
    assert.doesNotMatch(out.text, /127\.0\.0\.1|consumer_secret/);
  }
});

// The oldest public tool shipped with no annotations and no output schema while
// the four Release Gate tools carried both. Smithery and Glama read the running
// server rather than a listing, and the Claude and OpenAI directories require
// annotations that match real behaviour, so the gap was a listing defect on the
// tool a caller reaches first.
test("the public tool advertises annotations that match what it actually does", () => {
  const tool = publicScanMcpTool(fakeFetch);
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true, destructiveHint: false, openWorldHint: true,
  });
});

test("the public tool advertises an output schema its own projection satisfies", async () => {
  const tool = publicScanMcpTool(fakeFetch);
  assert.ok(tool.outputSchema, "tools/list must publish the result shape");

  const schema = tool.outputSchema as {
    required: string[]; properties: Record<string, unknown>;
  };
  const result = await runPublicScan({ demo: true }, fakeFetch);
  const keys = Object.keys(result).sort();

  // every advertised key exists on the real result, and nothing extra leaks
  assert.deepEqual(keys, [...schema.required].sort());
  assert.deepEqual(keys, Object.keys(schema.properties).sort());
  assert.equal(result.billable, false);
});
