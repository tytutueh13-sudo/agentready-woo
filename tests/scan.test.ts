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
  assert.equal((result.score ?? 0) >= 80, true, `expected good, got ${result.score}`);
  assert.equal(result.grade, "good");
  assert.ok(result.checks.every(c => typeof c.ok === "boolean"));
  const failed = result.checks.filter(c => !c.ok).map(c => c.id);
  assert.deepEqual(failed, [], `unexpected failures: ${failed.join(",")}`);
  assert.deepEqual(result.recommendations, [], "a passing scan must not upsell an unrelated surface");
});

// The scan used to answer this case with a number. A store that answered
// nothing failed every check for the same reason and came back around 18/100,
// grade "poor" — presented to the merchant as a finding about their shop, and
// returned from the public MCP tool the same way. It is an abstention.
test("a store that answers nothing produces an abstention, not a low score", async () => {
  const result = await scanStore(STORE, fakeFetch(() => { throw new Error("ECONNREFUSED"); }));
  assert.equal(result.state, "UNREADABLE");
  assert.equal(result.score, null, "a score here would be a score of our own timeout");
  assert.equal(result.grade, null);
  assert.equal(result.unreadable?.reason, "TARGET_UNREACHABLE");
  assert.match(result.unreadable?.detail ?? "", /nothing answered/);
  assert.deepEqual(result.recommendations, [],
    "advice derived from checks that only failed because nothing answered is advice about our timeouts");
  assert.ok(result.checks.length > 0, "what was attempted is still recorded");
});

test("a store that answers an error status abstains with that status named", async () => {
  const result = await scanStore(STORE, fakeFetch(() => new Response("maintenance", { status: 503 })));
  assert.equal(result.state, "UNREADABLE");
  assert.equal(result.score, null);
  assert.equal(result.unreadable?.reason, "TARGET_UNREADABLE");
  assert.match(result.unreadable?.detail ?? "", /503/);
});

test("one readable surface is enough to score: a blocked homepage with a live Store API", async () => {
  // The abstention must be narrow. If either surface answered there is real
  // evidence, and refusing to score would hide findings the scan did make.
  const result = await scanStore(STORE, fakeFetch(url =>
    url.pathname === "/wp-json/wc/store/v1/products"
      ? jsonResponse([{ id: 1, name: "Shoes", prices: { price: "1" }, stock_status: "instock", description: "<p>A real description of the product for agents.</p>", images: [{ src: "a.jpg" }], status: "publish" }])
      : new Response("", { status: 403 })));
  assert.equal(result.state, "SCORED");
  assert.equal(typeof result.score, "number");
  assert.ok(result.checks.find(c => c.id === "store_api" && c.ok === true));
});

test("a scored store keeps its score, its grade and no abstention", async () => {
  const result = await scanStore(STORE, fakeFetch(healthyWooHandler));
  assert.equal(result.state, "SCORED");
  assert.equal(result.unreadable, null);
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

// A storefront answering 530 (Cloudflare could not reach the origin) is down,
// not reachable. Counting any status at all as a pass told a broken shop it
// responds and handed it a point it had not earned — found while reading a
// real scan of a store that was actually offline.
test("a storefront that errors is not counted as reachable", async () => {
  for (const status of [500, 503, 530]) {
    const result = await scanStore("https://shop.example.com", (async () => new Response("", {
      status, headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch);
    const reachable = result.checks.find(c => c.id === "reachable");
    assert.equal(reachable?.ok, false, `HTTP ${status} must not pass`);
    assert.equal(reachable?.detail, `HTTP ${status}`);
  }
});

test("a storefront that answers normally still passes", async () => {
  const result = await scanStore("https://shop.example.com", (async () => new Response("<title>Shop</title>", {
    status: 200, headers: { "content-type": "text/html" },
  })) as unknown as typeof fetch);
  assert.equal(result.checks.find(c => c.id === "reachable")?.ok, true);
});

// Found on a live scan: a real WooCommerce shop behind a bot challenge
// answered 202 with no markup, so "WooCommerce detected" said no while the
// very next check found its WooCommerce Store API answering. A responding
// Store API is WooCommerce; the markup only failed to prove it.
test("a responding Store API settles detection when the homepage markup is unreadable", async () => {
  const impl = (async (url: string) => url.includes("/wp-json/wc/store/")
    ? new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } })
    : new Response("<html><body>challenge</body></html>", { status: 200, headers: { "content-type": "text/html" } })
  ) as unknown as typeof fetch;

  const result = await scanStore("https://shop.example.com", impl);
  const woo = result.checks.find(c => c.id === "woo_detected");
  assert.equal(woo?.ok, true);
  assert.match(woo?.detail ?? "", /Store API responds/);
});

test("a site with neither markers nor a Store API is still not WooCommerce", async () => {
  const impl = (async (url: string) => url.includes("/wp-json/wc/store/")
    ? new Response("not found", { status: 404, headers: { "content-type": "text/html" } })
    : new Response("<html><title>Blog</title></html>", { status: 200, headers: { "content-type": "text/html" } })
  ) as unknown as typeof fetch;

  const result = await scanStore("https://blog.example.com", impl);
  assert.equal(result.checks.find(c => c.id === "woo_detected")?.ok, false);
});
