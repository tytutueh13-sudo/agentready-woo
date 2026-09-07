import type { McpTool } from "./core/mcpRpc.ts";
import { scanStore, type FetchLike, type ScanResult } from "./core/scan.ts";
import { normalizeStoreUrl } from "./core/tenants.ts";

export const PUBLIC_SCAN_TOOL_NAME = "scan_woo_store_readiness";

export const PUBLIC_SCAN_TOOL_DESCRIPTION =
  "Check whether a public WooCommerce storefront is readable by shopping agents. "
  + "Provide the store's HTTPS origin. The tool reads only public pages and the public WooCommerce Store API, "
  + "changes nothing, and returns aggregate checks and recommendations without product text or customer data. "
  + "When the storefront cannot be read at all, the tool abstains: state is UNREADABLE, score and grade are null, "
  + "and the caller must not present that as a finding about the store.";

export const PUBLIC_SCAN_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    store_url: {
      type: "string",
      format: "uri",
      maxLength: 200,
      description: "Public HTTPS origin of the WooCommerce storefront, for example https://shop.example.com",
    },
    demo: {
      type: "boolean",
      const: true,
      description: "Run a deterministic synthetic demonstration instead of scanning a live store.",
    },
  },
  oneOf: [
    { required: ["store_url"], not: { required: ["demo"] } },
    { required: ["demo"], not: { required: ["store_url"] } },
  ],
  additionalProperties: false,
};

/** What `tools/list` publishes about the result shape.
 *
 * The four Release Gate tools each carry an output schema and annotations; this
 * one shipped with neither, and it is the tool a caller reaches first. Smithery
 * and Glama read the running server rather than a listing, and the Claude and
 * OpenAI directories require annotations that match real behaviour — so a
 * missing hint on the busiest tool does not read as neutral, it reads as
 * unknown. The scan reads public pages and the public Store API and writes
 * nothing, which is exactly `readOnlyHint`. */
export const PUBLIC_SCAN_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "state", "score", "grade", "unreadable", "checks", "product_count_sampled",
    "recommendations", "scanned_at", "billable", "evidence_status",
  ],
  properties: {
    state: {
      type: "string",
      enum: ["SCORED", "UNREADABLE"],
      description: "UNREADABLE is an abstention, not a verdict about the store.",
    },
    score: { type: ["number", "null"], minimum: 0, maximum: 100 },
    grade: { type: ["string", "null"] },
    unreadable: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["reason", "detail"],
      properties: { reason: { type: "string" }, detail: { type: "string" } },
      description: "Why nothing could be read. Null when the scan produced a score.",
    },
    checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "ok", "weight"],
        properties: {
          id: { type: "string" }, label: { type: "string" },
          ok: { type: "boolean" }, weight: { type: "number" },
        },
      },
    },
    product_count_sampled: { type: "integer", minimum: 0 },
    recommendations: { type: "array", items: { type: "string" } },
    scanned_at: { type: "integer" },
    billable: { const: false },
    evidence_status: { type: "string", enum: ["LIVE_PUBLIC_SCAN", "SYNTHETIC_DEMO"] },
  },
};

export const PUBLIC_SCAN_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
} as const;

export interface PublicScanResult {
  state: ScanResult["state"];
  score: number | null;
  grade: ScanResult["grade"];
  unreadable: { reason: string; detail: string } | null;
  checks: Array<{ id: string; label: string; ok: boolean; weight: number }>;
  product_count_sampled: number;
  recommendations: string[];
  scanned_at: number;
  billable: false;
  evidence_status: "LIVE_PUBLIC_SCAN" | "SYNTHETIC_DEMO";
}

/** A marketplace-safe projection. Product names/descriptions, page titles,
 * the submitted store URL, and endpoint details never leave this boundary. */
export function publicScanProjection(result: ScanResult): PublicScanResult {
  return {
    state: result.state,
    score: result.score,
    grade: result.grade,
    unreadable: result.unreadable ? { ...result.unreadable } : null,
    checks: result.checks.map(({ id, label, ok, weight }) => ({ id, label, ok, weight })),
    product_count_sampled: result.productCount,
    recommendations: [...result.recommendations],
    scanned_at: result.scannedAt,
    billable: false,
    evidence_status: "LIVE_PUBLIC_SCAN",
  };
}

function syntheticDemoResult(): PublicScanResult {
  return {
    state: "SCORED",
    score: 72,
    grade: "fair",
    unreadable: null,
    checks: [
      { id: "https", label: "HTTPS storefront", ok: true, weight: 15 },
      { id: "store_api", label: "WooCommerce Store API", ok: true, weight: 20 },
      { id: "structured_data", label: "Product structured data", ok: true, weight: 15 },
      { id: "agent_discovery", label: "Agent discovery file", ok: false, weight: 15 },
    ],
    product_count_sampled: 8,
    recommendations: ["Publish an agent discovery file that documents the public catalog surface."],
    scanned_at: 0,
    billable: false,
    evidence_status: "SYNTHETIC_DEMO",
  };
}

export async function runPublicScan(
  args: Record<string, unknown>, fetchImpl: FetchLike = fetch,
): Promise<PublicScanResult> {
  const unexpected = Object.keys(args).filter((key) => key !== "store_url" && key !== "demo");
  if (unexpected.length > 0) throw new Error("unexpected argument");
  if (args.demo === true && args.store_url === undefined) return syntheticDemoResult();
  if (args.demo !== undefined) throw new Error("choose either demo or store_url");
  const storeUrl = normalizeStoreUrl(String(args.store_url ?? ""));
  return publicScanProjection(await scanStore(storeUrl, fetchImpl));
}

export function publicScanMcpTool(fetchImpl: FetchLike = fetch): McpTool {
  return {
    name: PUBLIC_SCAN_TOOL_NAME,
    description: PUBLIC_SCAN_TOOL_DESCRIPTION,
    inputSchema: PUBLIC_SCAN_INPUT_SCHEMA,
    outputSchema: PUBLIC_SCAN_OUTPUT_SCHEMA,
    annotations: { ...PUBLIC_SCAN_ANNOTATIONS },
    async run(args) {
      try {
        const result = await runPublicScan(args, fetchImpl);
        return { ok: true, text: JSON.stringify(result, null, 2) };
      } catch {
        return {
          ok: false,
          text: JSON.stringify({
            error: "STORE_SCAN_REFUSED",
            message: "Provide a public HTTPS storefront origin and try again.",
          }),
        };
      }
    },
  };
}
