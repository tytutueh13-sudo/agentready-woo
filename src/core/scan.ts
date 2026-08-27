// Free store scan: the landing's "Check your store — free" promise.
// Read-only checks against the merchant's own public endpoints. No store
// credentials required; authenticated Woo checks run only when keys are given.

export interface ScanCheck { id: string; label: string; ok: boolean; detail: string; weight: number; }
export interface SampleProduct { title: string; description: string; hasImage: boolean }
export interface ScanResult {
  storeUrl: string;
  score: number;
  grade: "good" | "fair" | "poor";
  checks: ScanCheck[];
  productCount: number;
  scannedAt: number;
  recommendations: string[];
  /** A handful of the weakest-description products, kept for the deep
   * report's AI content review — everything else about a scan is
   * pass/fail counts, but rewriting a description needs the actual text. */
  sampleProducts: SampleProduct[];
}

const FETCH_TIMEOUT_MS = 8_000;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

async function fetchText(url: string, fetchImpl: FetchLike, init?: RequestInit): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...init });
    return { ok: res.ok, status: res.status, text: (await res.text()).slice(0, 100_000) };
  } catch {
    return { ok: false, status: 0, text: "" };
  }
}

function check(id: string, label: string, ok: boolean, detail: string, weight = 1): ScanCheck {
  return { id, label, ok, detail, weight };
}

export async function scanStore(
  rawStoreUrl: string,
  fetchImpl: FetchLike,
  wooKeys?: { consumerKey: string; consumerSecret: string },
): Promise<ScanResult> {
  const storeUrl = rawStoreUrl.trim().replace(/\/+$/, "");
  const recommendations: string[] = [];
  const checks: ScanCheck[] = [];

  const httpsOk = /^https:\/\/[^\s]+\.[^\s]+/.test(storeUrl);
  checks.push(check("https", "Store is served over HTTPS", httpsOk, httpsOk ? storeUrl : "https:// required"));
  if (!httpsOk) {
    recommendations.push("Serve your store over HTTPS — agents will not query insecure origins.");
  }

  const home = await fetchText(storeUrl, fetchImpl);
  checks.push(check("reachable", "Store responds to requests", home.ok || home.status > 0,
    home.ok ? `HTTP ${home.status}` : home.status ? `HTTP ${home.status}` : "unreachable"));
  checks.push(check("site_title", "Site metadata readable", /<title>[^<]{2,}<\/title>/i.test(home.text),
    /<title>([^<]{2,})<\/title>/i.exec(home.text)?.[1]?.slice(0, 60) ?? "no <title> found"));

  const isWoo = /woocommerce/i.test(home.text);
  checks.push(check("woo_detected", "WooCommerce detected", isWoo, isWoo ? "woocommerce markers found" : "no woocommerce marker on homepage"));

  const storeApi = await fetchText(`${storeUrl}/wp-json/wc/store/v1/products?per_page=20`, fetchImpl);
  let products: Array<Record<string, unknown>> = [];
  let totalCount = 0;
  if (storeApi.ok) {
    try {
      products = JSON.parse(storeApi.text) as Array<Record<string, unknown>>;
      totalCount = Number(storeApi.text.length >= 0 ? (products.length >= 20 ? 20 : products.length) : 0);
    } catch { products = []; }
  }
  const apiOk = storeApi.ok && Array.isArray(products);
  checks.push(check("store_api", "WooCommerce Store API responds", apiOk,
    apiOk ? `${storeUrl}/wp-json/wc/store/v1/products` : `HTTP ${storeApi.status}`));
  if (!apiOk) recommendations.push("WooCommerce Store API is not reachable — agents cannot read your catalog at all until this works.");

  const published = products.filter(p => p.status === undefined || p.status === "publish");
  const withPrice = published.filter(p => typeof p.prices === "object" && p.prices !== null);
  const withStock = published.filter(p => typeof p.stock_status === "string" && p.stock_status !== "");
  const withImages = published.filter(p => Array.isArray(p.images) && (p.images as unknown[]).length > 0);
  const withDesc = published.filter(p => typeof p.description === "string" && String(p.description).replace(/<[^>]*>/g, "").trim().length > 20);

  const sample = Math.max(published.length, 1);
  const ratio = (n: number) => n / sample;

  checks.push(check("products_exist", "Published products exist", published.length > 0, `${published.length} sampled`));
  checks.push(check("prices", "Products have prices", published.length > 0 && ratio(withPrice.length) >= 0.9,
    `${withPrice.length}/${published.length}`));
  checks.push(check("stock", "Stock status exposed", published.length > 0 && ratio(withStock.length) >= 0.9,
    `${withStock.length}/${published.length}`));
  checks.push(check("images", "Product images present", published.length > 0 && ratio(withImages.length) >= 0.8,
    `${withImages.length}/${published.length}`));
  checks.push(check("descriptions", "Descriptions are substantive", published.length > 0 && ratio(withDesc.length) >= 0.6,
    `${withDesc.length}/${published.length}`));

  if (published.length > 0 && ratio(withPrice.length) < 0.9) recommendations.push("Some products are missing prices — agents skip offers without a price.");
  if (published.length > 0 && ratio(withDesc.length) < 0.6) recommendations.push("Write real descriptions (20+ characters) — agents use them to answer buyer questions.");

  const descLength = (p: Record<string, unknown>) => String(p.description ?? "").replace(/<[^>]*>/g, "").trim().length;
  const sampleProducts: SampleProduct[] = [...published]
    .sort((a, b) => descLength(a) - descLength(b))
    .slice(0, 5)
    .map(p => ({
      title: String(p.name ?? "").trim(),
      description: String(p.description ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
      hasImage: Array.isArray(p.images) && (p.images as unknown[]).length > 0,
    }))
    .filter(p => p.title);

  // Cheap: reuses the homepage fetch already done above rather than a
  // second request. A real Product/ItemList JSON-LD block is what most
  // SEO plugins (Yoast, Rank Math) already emit — its absence is a real
  // gap for AI agents that read structured data, not just crawlable text.
  const hasProductJsonLd = /<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?"@type"\s*:\s*"(Product|ItemList)"[\s\S]*?<\/script>/i.test(home.text);
  checks.push(check("structured_data", "Product structured data (JSON-LD) present", hasProductJsonLd,
    hasProductJsonLd ? "Product/ItemList schema found" : "no schema.org Product markup found", 2));
  if (!hasProductJsonLd) recommendations.push("Add Product structured data (JSON-LD) — most SEO plugins (Yoast, Rank Math) can do this automatically.");

  const discovery = await fetchText(`${storeUrl}/.well-known/agenticweb.md`, fetchImpl);
  checks.push(check("discovery", "Agent discovery file published", discovery.ok && discovery.text.includes("Agentic commerce") === false ? discovery.ok : discovery.ok,
    discovery.ok ? "/.well-known/agenticweb.md live" : "missing — install the AgentReady Woo plugin"));
  if (!discovery.ok) recommendations.push("Publish /.well-known/agenticweb.md (the free AgentReady Woo plugin does this in one install).");

  const robots = await fetchText(`${storeUrl}/robots.txt`, fetchImpl);
  const robotsText = robots.text.toLowerCase();
  const gptAllowed = !robots.ok || !(new RegExp(`user-agent:\\s*gptbot[\\s\\S]*?disallow:\\s*/`).test(robotsText));
  const claudeAllowed = !robots.ok || !(new RegExp(`user-agent:\\s*claudebot[\\s\\S]*?disallow:\\s*/`).test(robotsText));
  checks.push(check("robots_ai", "AI crawlers not blocked in robots.txt", gptAllowed && claudeAllowed,
    gptAllowed && claudeAllowed ? "GPTBot/ClaudeBot not disallowed" : "AI crawler blocked"));
  if (!robots.ok) recommendations.push("No robots.txt found — add one that explicitly allows GPTBot and ClaudeBot.");
  else if (!(gptAllowed && claudeAllowed)) recommendations.push("robots.txt blocks AI crawlers — allow GPTBot and ClaudeBot or agents cannot read you.");

  if (wooKeys && wooKeys.consumerKey && wooKeys.consumerSecret) {
    const auth = "Basic " + btoa(`${wooKeys.consumerKey}:${wooKeys.consumerSecret}`);
    const wooV3 = await fetchText(`${storeUrl}/wp-json/wc/v3/products?per_page=20`, fetchImpl, { headers: { authorization: auth } });
    checks.push(check("woo_keys", "WooCommerce REST keys work", wooV3.ok, wooV3.ok ? "wc/v3 authenticated" : `HTTP ${wooV3.status}`));
    if (!wooV3.ok) recommendations.push("Your REST API keys were rejected — regenerate a read-only key in WooCommerce → Settings → Advanced → REST API.");
    if (wooV3.ok) {
      // brand/GTIN aren't in the public Store API used above — they only
      // show up on the authenticated wc/v3 admin endpoint, added to
      // WooCommerce core for exactly this (Google/AI shopping feed
      // compliance). Best-effort: read them if present, never block the
      // rest of the scan if the shape doesn't match what's expected here.
      try {
        const v3Products = JSON.parse(wooV3.text) as Array<Record<string, unknown>>;
        const v3Published = v3Products.filter(p => p.status === undefined || p.status === "publish");
        const v3Sample = Math.max(v3Published.length, 1);
        const withGtin = v3Published.filter(p => typeof p.global_unique_id === "string" && p.global_unique_id.trim() !== "");
        const withBrand = v3Published.filter(p => Array.isArray(p.brands) && (p.brands as unknown[]).length > 0);
        const identifierRatio = (withGtin.length + withBrand.length) / (v3Sample * 2);
        const identifiersOk = v3Published.length > 0 && identifierRatio >= 0.5;
        checks.push(check("product_identifiers", "Brand/GTIN set on products (required for AI shopping feeds)", identifiersOk,
          `${withBrand.length}/${v3Published.length} have a brand, ${withGtin.length}/${v3Published.length} have a GTIN`, 2));
        if (!identifiersOk) recommendations.push("Set a brand and GTIN/UPC/EAN on your products — OpenAI's shopping feed spec requires brand and strongly recommends GTIN.");
      } catch { /* unexpected wc/v3 shape — skip this check rather than fail the scan */ }
    }
  }

  const totalWeight = checks.reduce((sum, c) => sum + c.weight, 0);
  const passedWeight = checks.filter(c => c.ok).reduce((sum, c) => sum + c.weight, 0);
  const score = Math.round((passedWeight / totalWeight) * 100);
  const grade = score >= 80 ? "good" : score >= 50 ? "fair" : "poor";

  if (apiOk) recommendations.push("Your catalog is readable. Connect an AgentReady feed to become buyable: signed cart handoff + agent analytics.");

  return {
    storeUrl,
    score,
    grade,
    checks,
    productCount: totalCount || published.length,
    scannedAt: Date.now(),
    recommendations,
    sampleProducts,
  };
}
