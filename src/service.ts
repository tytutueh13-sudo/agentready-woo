// Core business logic — shared by the MCP tool handler and the HTTP API
// handler (section 21: no duplicated logic between the two).
//
// AgentReady Woo: translates a merchant's own WooCommerce catalog into an
// agent-readable surface. Reads only the merchant's own REST API (their keys,
// zero per-call upstream cost) and never stores card data or product copies.

export interface ToolInput {
  [key: string]: unknown;
}

export interface ToolOutput {
  [key: string]: unknown;
}

export interface ServiceConfig {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  cartSigningSecret: string;
  publicBaseUrl: string;
}

const DEFAULT_CONFIG: ServiceConfig = {
  storeUrl: "",
  consumerKey: "",
  consumerSecret: "",
  cartSigningSecret: "",
  publicBaseUrl: "",
};

let activeConfig: ServiceConfig = { ...DEFAULT_CONFIG };
let activeFetch: typeof fetch = (...args) => fetch(...args);

export function configFromEnv(env: Record<string, string | undefined>): ServiceConfig {
  return {
    storeUrl: (env.WOO_STORE_URL ?? "").replace(/\/+$/, ""),
    consumerKey: env.WOO_CONSUMER_KEY ?? "",
    consumerSecret: env.WOO_CONSUMER_SECRET ?? "",
    cartSigningSecret: env.CART_SIGNING_SECRET ?? "",
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, ""),
  };
}

export function configureService(
  env: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): void {
  activeConfig = configFromEnv(env);
  if (fetchImpl) activeFetch = fetchImpl;
}

function requireConfig(): ServiceConfig {
  const c = activeConfig;
  const missing: string[] = [];
  if (!c.storeUrl) missing.push("WOO_STORE_URL");
  if (!c.consumerKey || !c.consumerSecret) missing.push("WOO_CONSUMER_KEY/WOO_CONSUMER_SECRET");
  if (!c.cartSigningSecret) missing.push("CART_SIGNING_SECRET");
  if (missing.length > 0) {
    throw new Error(`agentready woo is not configured — missing ${missing.join(", ")}`);
  }
  return c;
}

interface WooProduct {
  id?: unknown;
  name?: unknown;
  permalink?: unknown;
  price?: unknown;
  stock_status?: unknown;
  short_description?: unknown;
  images?: unknown;
  status?: unknown;
  // Native WooCommerce core fields (wc/v3 only) added for Google/AI
  // shopping feed compliance — best-effort reads, see normalizeOffer().
  global_unique_id?: unknown;
  brands?: unknown;
}

function stripHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** WooCommerce's own stock_status values, mapped to the availability enum
 * OpenAI's ACP product feed spec expects (in_stock / out_of_stock /
 * preorder). WooCommerce has no native "preorder" stock_status — a
 * merchant using a preorder plugin would still show onbackorder here,
 * which maps close enough (both mean "not in hand yet, but sellable"). */
function availabilityFor(stockStatus: unknown): string {
  if (stockStatus === "instock") return "in_stock";
  if (stockStatus === "onbackorder") return "backorder";
  return "out_of_stock";
}

function normalizeOffer(p: WooProduct): ToolOutput {
  const images = Array.isArray(p.images) ? p.images : [];
  const first = images.length > 0 && typeof images[0] === "object"
    ? (images[0] as { src?: unknown })
    : undefined;
  const brands = Array.isArray(p.brands) ? p.brands as Array<Record<string, unknown>> : [];
  const brandName = brands.length > 0 && typeof brands[0]?.name === "string" ? brands[0].name as string : null;
  return {
    id: p.id ?? null,
    title: typeof p.name === "string" ? p.name : "",
    price_amount: p.price !== undefined && p.price !== "" ? Number(p.price) : null,
    currency_note: "store default currency (from WooCommerce settings)",
    url: typeof p.permalink === "string" ? p.permalink : "",
    in_stock: p.stock_status === "instock",
    availability: availabilityFor(p.stock_status),
    summary: stripHtml(p.short_description),
    image: typeof first?.src === "string" ? first.src : null,
    brand: brandName,
    gtin: typeof p.global_unique_id === "string" && p.global_unique_id.trim() !== "" ? p.global_unique_id : null,
  };
}

async function wooRequest(
  config: ServiceConfig, path: string, params: Record<string, string>,
): Promise<{ body: unknown; total: number }> {
  const url = new URL(`${config.storeUrl}/wp-json/wc/v3/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const auth = btoa(`${config.consumerKey}:${config.consumerSecret}`);
  const response = await activeFetch(url.toString(), {
    headers: { authorization: `Basic ${auth}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `woocommerce api error (${response.status}) on ${path}: ${detail.slice(0, 200)}`,
    );
  }
  const body: unknown = await response.json();
  const total = Number(response.headers.get("x-wp-total") ?? "0");
  return { body, total: Number.isFinite(total) ? total : 0 };
}

async function listProducts(
  config: ServiceConfig, params: Record<string, string>,
): Promise<{ offers: ToolOutput[]; total: number }> {
  const { body, total } = await wooRequest(config, "products", {
    status: "publish", ...params,
  });
  if (!Array.isArray(body)) throw new Error("woocommerce returned a non-list product response");
  return { offers: (body as WooProduct[]).map(normalizeOffer), total };
}

async function fetchOneOffer(config: ServiceConfig, productId: number): Promise<ToolOutput> {
  const { body } = await wooRequest(config, `products/${productId}`, {});
  if (!body || typeof body !== "object") throw new Error("woocommerce returned an invalid product");
  return normalizeOffer(body as WooProduct);
}

const DEFAULT_CART_TTL_SECONDS = 900;
const MAX_CART_TTL_SECONDS = 3600;

async function signPayload(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function cartBasePath(productId: number, quantity: number): string {
  return `/?add-to-cart=${productId}&quantity=${quantity}`;
}

async function createCartLink(config: ServiceConfig, input: ToolInput): Promise<ToolOutput> {
  const productId = Number(input.product_id);
  if (!Number.isInteger(productId) || productId <= 0) {
    throw new Error("product_id must be a positive integer");
  }
  const quantity = Math.min(Math.max(Number(input.quantity ?? 1) || 1, 1), 99);
  const requested = Number(input.expiry_seconds ?? DEFAULT_CART_TTL_SECONDS);
  const ttl = Math.min(Math.max(Number.isFinite(requested) ? requested : DEFAULT_CART_TTL_SECONDS, 60), MAX_CART_TTL_SECONDS);

  const offer = await fetchOneOffer(config, productId);
  if (!offer.in_stock) throw new Error(`product ${productId} is not in stock`);

  const base = `${config.storeUrl}${cartBasePath(productId, quantity)}`;
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const signature = await signPayload(config.cartSigningSecret, `${base}\n${exp}`);
  const cartUrl = `${base}&agentready_exp=${exp}&agentready_sig=${signature}`;
  return {
    cart_url: cartUrl,
    expires_at: new Date(exp * 1000).toISOString(),
    offer,
    note: "buyer completes checkout on the merchant's own site — human-approved purchase",
  };
}

export async function verifyCartLink(
  config: ServiceConfig, rawUrl: string, nowSeconds = Math.floor(Date.now() / 1000),
): Promise<ToolOutput> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: "malformed url" };
  }
  const expectedHost = new URL(config.storeUrl).host;
  if (parsed.host !== expectedHost) return { valid: false, reason: "host does not match the configured store" };

  const sig = parsed.searchParams.get("agentready_sig");
  const expRaw = parsed.searchParams.get("agentready_exp");
  if (!sig || !expRaw) return { valid: false, reason: "missing signature parameters" };
  const exp = Number(expRaw);
  if (!Number.isFinite(exp)) return { valid: false, reason: "malformed expiry" };
  if (nowSeconds >= exp) return { valid: false, reason: "link expired" };

  const base = `${parsed.origin}${parsed.pathname}?${(() => {
    const kept = new URLSearchParams(parsed.searchParams);
    kept.delete("agentready_sig");
    kept.delete("agentready_exp");
    return kept.toString();
  })()}`;
  const expected = await signPayload(config.cartSigningSecret, `${base}\n${exp}`);
  if (expected.length !== sig.length || expected !== sig) {
    return { valid: false, reason: "signature mismatch" };
  }
  const productId = Number(new URLSearchParams(base.split("?")[1] ?? "").get("add-to-cart"));
  return {
    valid: true,
    product_id: Number.isInteger(productId) ? productId : null,
    quantity: Number(new URLSearchParams(base.split("?")[1] ?? "").get("quantity") ?? "1"),
    expires_at: new Date(exp * 1000).toISOString(),
  };
}

function buildFeed(config: ServiceConfig, offers: ToolOutput[], nowIso: string): ToolOutput {
  return {
    generator: {
      name: "AgentReady Woo",
      version: "1.0.0",
      discovery: `${config.publicBaseUrl || config.storeUrl}/.well-known/agenticweb.md`,
      mcp_endpoint: `${config.publicBaseUrl || config.storeUrl}/mcp`,
    },
    store: config.storeUrl,
    updated_at: nowIso,
    currency_note: "prices are strings/numbers in the store's own currency",
    offers,
  };
}

export const SUPPORTED_ACTIONS = [
  "search_products",
  "get_offer",
  "get_feed",
  "create_cart_link",
  "verify_cart_link",
] as const;

export async function runTool(input: ToolInput, configOverride?: ServiceConfig): Promise<ToolOutput> {
  const config = configOverride ?? requireConfig();
  const action = typeof input.action === "string" ? input.action : "";
  switch (action) {
    case "search_products": {
      const query = String(input.query ?? "").slice(0, 200);
      const perPage = Math.min(Math.max(Number(input.per_page ?? 10) || 10, 1), 20);
      const page = Math.max(Number(input.page ?? 1) || 1, 1);
      const { offers, total } = await listProducts(config, {
        search: query, per_page: String(perPage), page: String(page),
        orderby: "relevance",
      });
      return { action, query, page, total_results: total, offers };
    }
    case "get_offer": {
      const productId = Number(input.product_id);
      if (!Number.isInteger(productId) || productId <= 0) {
        throw new Error("product_id must be a positive integer");
      }
      return { action, offer: await fetchOneOffer(config, productId) };
    }
    case "get_feed": {
      const { offers, total } = await listProducts(config, {
        per_page: "50", orderby: "date", order: "desc",
      });
      return { ...buildFeed(config, offers, new Date().toISOString()), total_results: total };
    }
    case "create_cart_link":
      return createCartLink(config, input);
    case "verify_cart_link": {
      const url = String(input.cart_url ?? "");
      if (!url) throw new Error("cart_url is required");
      return { action, ...(await verifyCartLink(config, url)) };
    }
    default:
      throw new Error(`unknown action '${action}' — expected one of ${SUPPORTED_ACTIONS.join(", ")}`);
  }
}

// UNKNOWN fails closed in the production guard. This service reads the
// merchant's own API (no metered upstream), so the enforceable maximum is a
// small flat per-request infrastructure figure (Worker invocation + KV reads).
export const FLAT_COST_PER_REQUEST = 0.0005;

export function estimateCost(_input: ToolInput): number {
  return FLAT_COST_PER_REQUEST;
}

export function measureActualCost(_result: unknown): number {
  return FLAT_COST_PER_REQUEST;
}

// /.well-known/agenticweb.md discovery metadata (pure function, testable).
export function buildAgenticWebMd(
  config: { storeUrl?: string; publicBaseUrl?: string },
): string {
  const base = (config.publicBaseUrl || config.storeUrl || "").replace(/\/+$/, "");
  const store = (config.storeUrl || "").replace(/\/+$/, "");
  return `# AgentReady Woo — agent capabilities for this store

This store exposes its live WooCommerce catalog to commerce agents through
an AgentReady Woo worker. Prices are in the store's own currency. Checkout
always completes on the merchant's own site through a human-approved,
time-limited signed cart link.

## Discovery
- This document: GET ${base}/.well-known/agenticweb.md
- Feed: POST ${base}/api/v1/agentready_woo_agentic_commerce_readiness_toolkit_for_self_h with {"input":{"action":"get_feed"}}
- MCP endpoint: POST ${base}/mcp {"tool":"agentready_woo_agentic_commerce_readiness_toolkit_for_self_h","input":{...}}

## Tools
- search_products {query, per_page?, page?} — search the live catalog
- get_offer {product_id} — full offer detail
- get_feed {} — recent offers with generator metadata
- create_cart_link {product_id, quantity?} — signed, expiring add-to-cart link (max 1h)
- verify_cart_link {cart_url} — verify signature/expiry before handoff

## Purchase boundary
No payment credentials flow through this service. Agents should present the
signed cart link to the buyer; the buyer completes checkout on ${store}.
`;
}
