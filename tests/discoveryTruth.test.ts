import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("public pages are indexable while private product routes stay blocked", () => {
  const html = read("marketing/landing/index.html");
  const robots = read("marketing/landing/robots.txt");
  assert.match(html, /<meta name="robots" content="index,follow,max-image-preview:large">/);
  assert.doesNotMatch(html, /noindex|nofollow/);
  const general = robots.split("# ── AI crawlers")[0];
  assert.match(general, /User-agent: \*\s+Allow: \//);
  for (const path of ["/dashboard", "/admin", "/api/", "/webhooks/", "/mcp", "/channels/"]) {
    assert.match(general, new RegExp(`Disallow: ${path.replace("/", "\\/")}`));
  }
});

test("AI discovery text names the five-tool Release Gate truth", () => {
  const llms = read("marketing/landing/llms.txt");
  for (const tool of ["scan_woo_store_readiness", "preflight_woo_store", "start_woo_release_verification", "get_woo_release_verification", "claim_woo_release_result"]) {
    assert.match(llms, new RegExp(tool));
  }
  assert.match(llms, /settlement is\s+currently disabled/i);
  assert.match(llms, /separate from\s+the root five-tool Release Gate contract/i);
  assert.doesNotMatch(llms, /Four tools|top-25 product feed/);
});

test("the public page links to the deployed discovery path", () => {
  const html = read("marketing/landing/index.html");
  assert.match(html, /href="\/\.well-known\/agenticweb\.md"/);
  assert.doesNotMatch(html, /agentic-web\.md/);
});

test("sitemap includes the public support and security surfaces", () => {
  const sitemap = read("marketing/landing/sitemap.xml");
  assert.match(sitemap, /https:\/\/app\.utilityhouse\.xyz\/support/);
  assert.match(sitemap, /https:\/\/app\.utilityhouse\.xyz\/security/);
  assert.doesNotMatch(sitemap, /\/dashboard|\/api\/|\/mcp/);
});

test("deployment binds Cloudflare version metadata for artifact identity", () => {
  const wrangler = read("wrangler.toml");
  assert.match(wrangler, /\[version_metadata\]\s+binding = "CF_VERSION_METADATA"/);
});

test("WordPress package describes the shipped Release Gate instead of the retired launch story", () => {
  const header = read("wordpress-plugin/utilityhouse-release-gate-for-woocommerce/utilityhouse-release-gate-for-woocommerce.php");
  const readme = read("wordpress-plugin/utilityhouse-release-gate-for-woocommerce/readme.txt");
  assert.match(header, /Version:\s+1\.2\.1/);
  assert.match(header, /UTILITYHOUSE_RELEASE_GATE_VERSION', '1\.2\.1'/);
  assert.match(readme, /Stable tag: 1\.2\.1/);
  assert.match(readme, /signed, aggregate-only Release Gate evidence/i);
  assert.match(readme, /settlement is disabled/i);
  for (const stale of ["More than a million Shopify", "+38%", "+138%", "wallets already out"]) {
    assert.ok(!readme.includes(stale), `WordPress readme must not retain: ${stale}`);
  }
});
