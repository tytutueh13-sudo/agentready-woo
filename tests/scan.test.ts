// Tests for the free store scan: checks run against a fake fetch, scoring
// stays bounded to 0-100, and recommendations appear for the gaps found.
import test from "node:test";
import assert from "node:assert/strict";
import { scanStore } from "../src/core/scan.ts";

const STORE = "https://northwind.example.com";

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function healthyWooHandler(url: URL): Response {
  const path = url.pathname;
  if (path === "/wp-json/wc/store/v1/products") {
    return jsonResponse([
      { id: 1, name: "Shoes", prices: { price: "12900" }, stock_status: "instock", description: "<p>A real description of the product for agents to read.</p>", images: [{ src: "a.jpg" }], status: "publish" },
      { id: 2, name: "Caps", prices: { price: "4900" }, stock_status: "instock", description: "<p>Another real description long enough to count as substantive.</p>", images: [{ src: "b.jpg" }], status: "publish" },
    ], { "x-wp-total": "2" });
  }
  if (url.pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /", { status: 200 });
  if (url.pathname === "/.well-known/agenticweb.md") return new Response("# NorthWind\n\n## Agentic commerce\n", { status: 200 });
  return new Response(
    `<html><title>NorthWind Wool</title><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"ItemList","itemListElement":[{"@type":"Product","name":"Shoes"}]}</script></head><body>powered by WooCommerce</body></html>`,
    { status: 200 },
  );
}

function fakeFetch(handler: (url: URL) => Response | Promise<Response>) {
  return async (input: string | URL): Promise<Response> => handler(new URL(String(input)));
}

test("a well-configured store scores good with no blocking recommendations", async () => {
  const result = await scanStore(STORE, fakeFetch(healthyWooHandler));
  assert.equal(result.score >= 80, true, `expected good, got ${result.score}`);
  assert.equal(result.grade, "good");
  assert.ok(result.checks.every(c => typeof c.ok === "boolean"));
  const failed = result.checks.filter(c => !c.ok).map(c => c.id);
  assert.deepEqual(failed, [], `unexpected failures: ${failed.join(",")}`);
});

test("an unreachable store fails closed with a low score", async () => {
  const result = await scanStore(STORE, fakeFetch(() => new Response("", { status: 0 })));
  assert.equal(result.score < 50, true);
  assert.equal(result.grade, "poor");
  assert.ok(result.recommendations.length > 0);
  assert.ok(result.checks.find(c => c.id === "https" && c.ok === true), "https check is about the URL, not reachability");
});

test("blocked AI crawlers and missing discovery produce recommendations", async () => {
  const handler = (url: URL): Response => {
    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: GPTBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /", { status: 200 });
    }
    if (url.pathname === "/.well-known/agenticweb.md") return new Response("nope", { status: 404 });
    return healthyWooHandler(url);
  };
  const result = await scanStore(STORE, fakeFetch(handler));
  assert.equal(result.checks.find(c => c.id === "robots_ai")?.ok, false);
  assert.equal(result.checks.find(c => c.id === "discovery")?.ok, false);
  assert.ok(result.recommendations.some(r => /GPTBot/.test(r)));
  assert.ok(result.recommendations.some(r => /plugin/.test(r)));
});

test("http-only store URLs fail the https check", async () => {
  const result = await scanStore("http://northwind.example.com", fakeFetch(healthyWooHandler));
  assert.equal(result.checks.find(c => c.id === "https")?.ok, false);
  assert.ok(result.recommendations.some(r => /HTTPS/.test(r)));
});

test("authenticated woo keys are checked only when supplied", async () => {
  const seen: string[] = [];
  const handler = (url: URL): Response => {
    seen.push(url.pathname);
    return healthyWooHandler(url);
  };
  await scanStore(STORE, fakeFetch(handler));
  assert.ok(!seen.includes("/wp-json/wc/v3/products"), "no key check without keys");

  const withKeys: string[] = [];
  const authHandler = (url: URL): Response => {
    withKeys.push(url.pathname);
    return healthyWooHandler(url);
  };
  await scanStore(STORE, fakeFetch(authHandler), { consumerKey: "ck_test", consumerSecret: "cs_test" });
  assert.ok(withKeys.includes("/wp-json/wc/v3/products"), "key check runs when keys are supplied");
});

// --- structured data / brand+GTIN checks (added for ACP feed compliance) ---

test("structured_data check reflects whether the homepage has Product/ItemList JSON-LD", async () => {
  const withoutJsonLd = await scanStore(STORE, fakeFetch(url => {
    if (url.pathname === "/") return new Response("<html><title>No schema here</title></html>", { status: 200 });
    return healthyWooHandler(url);
  }));
  assert.equal(withoutJsonLd.checks.find(c => c.id === "structured_data")?.ok, false);
  assert.ok(withoutJsonLd.recommendations.some(r => r.includes("structured data")));

  const withJsonLd = await scanStore(STORE, fakeFetch(healthyWooHandler));
  assert.equal(withJsonLd.checks.find(c => c.id === "structured_data")?.ok, true);
});

test("product_identifiers check passes when most sampled products have brand + GTIN", async () => {
  const handler = (url: URL): Response => {
    if (url.pathname === "/wp-json/wc/v3/products") {
      return jsonResponse([
        { id: 1, name: "Shoes", status: "publish", global_unique_id: "0123456789012", brands: [{ id: 1, name: "NorthWind" }] },
        { id: 2, name: "Caps", status: "publish", global_unique_id: "0987654321098", brands: [{ id: 1, name: "NorthWind" }] },
      ]);
    }
    return healthyWooHandler(url);
  };
  const result = await scanStore(STORE, fakeFetch(handler), { consumerKey: "ck_test", consumerSecret: "cs_test" });
  const identifiers = result.checks.find(c => c.id === "product_identifiers");
  assert.equal(identifiers?.ok, true);
  assert.match(identifiers?.detail ?? "", /2\/2 have a brand, 2\/2 have a GTIN/);
});

test("product_identifiers check fails and recommends fixes when brand/GTIN are missing", async () => {
  const handler = (url: URL): Response => {
    if (url.pathname === "/wp-json/wc/v3/products") {
      return jsonResponse([
        { id: 1, name: "Shoes", status: "publish" },
        { id: 2, name: "Caps", status: "publish" },
      ]);
    }
    return healthyWooHandler(url);
  };
  const result = await scanStore(STORE, fakeFetch(handler), { consumerKey: "ck_test", consumerSecret: "cs_test" });
  assert.equal(result.checks.find(c => c.id === "product_identifiers")?.ok, false);
  assert.ok(result.recommendations.some(r => r.includes("brand and GTIN")));
});

test("product_identifiers check is skipped (not a false failure) when wc/v3 returns an unexpected shape", async () => {
  const handler = (url: URL): Response => {
    if (url.pathname === "/wp-json/wc/v3/products") return new Response("not json", { status: 200 });
    return healthyWooHandler(url);
  };
  const result = await scanStore(STORE, fakeFetch(handler), { consumerKey: "ck_test", consumerSecret: "cs_test" });
  assert.equal(result.checks.find(c => c.id === "product_identifiers"), undefined);
  assert.equal(result.checks.find(c => c.id === "woo_keys")?.ok, true, "the keys still worked even if the body was unparseable");
});

test("sampleProducts captures the weakest-description products for the deep report", async () => {
  const handler = (url: URL): Response => {
    if (url.pathname === "/wp-json/wc/store/v1/products") {
      return jsonResponse([
        { id: 1, name: "Great Product", prices: { price: "1000" }, stock_status: "instock", description: "<p>A genuinely thorough and useful description of this product for shoppers.</p>", images: [{ src: "a.jpg" }], status: "publish" },
        { id: 2, name: "Thin Product", prices: { price: "2000" }, stock_status: "instock", description: "<p>ok</p>", images: [{ src: "b.jpg" }], status: "publish" },
      ], { "x-wp-total": "2" });
    }
    return healthyWooHandler(url);
  };
  const result = await scanStore(STORE, fakeFetch(handler));
  assert.equal(result.sampleProducts[0]?.title, "Thin Product", "weakest description should sort first");
  assert.equal(result.sampleProducts[0]?.description, "ok");
});
