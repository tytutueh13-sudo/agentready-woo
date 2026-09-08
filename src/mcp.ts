// Minimal MCP-*shaped* tool endpoint: accepts { tool, input }, returns
// { result } or { error }. NOT a full JSON-RPC 2.0 MCP protocol
// implementation (see README.md "Not implemented yet" — wiring the official
// @modelcontextprotocol/sdk framing is a follow-up task).
import { runTool, estimateCost, measureActualCost, SUPPORTED_ACTIONS, type ToolInput , type ServiceConfig } from "./service.ts";
import { RevenueGuard } from "./core/guard.ts";
import type { PaymentProvider } from "./core/paymentProvider.ts";

export const TOOL_NAME = "agentready_woo_agentic_commerce_readiness_toolkit_for_self_h";

/** Describes the SERVER to a person reading a registry listing. Not what an
 * agent reads to decide whether to call a tool — that is TOOL_DESCRIPTION,
 * which answers "when would I call this?" instead of "what did you build?". */
export const SERVER_DESCRIPTION = "A privacy-safe WooCommerce preflight and owner-authorized Release Gate. Public tools inspect public storefront and protocol surfaces without changing the store. Authenticated tools make a version-pinned release decision from signed aggregate plugin evidence. Unreadable targets produce abstentions, replays are not billable, and no root tool creates orders or handles payment credentials.";

/** What the calling model reads. Written as the question the tool answers,
 * because a description of the product tells a model nothing about when to
 * reach for it. The production root surface shipped the product blurb here
 * and an `action: string` with no enum, so no agent could construct a valid
 * call at all — this constant and TOOL_INPUT_SCHEMA exist so the root and
 * per-store surfaces cannot drift apart into that state again. */
export const TOOL_DESCRIPTION =
  "Read one WooCommerce store's public catalogue and prepare a purchase the shopper completes themselves. "
  + "Actions: search_products (query) to find items; get_feed for the recent catalogue; get_offer (product_id) "
  + "for one item's price and availability; create_cart_link (product_id, quantity) which returns a signed link "
  + "the shopper opens in their own browser; verify_cart_link (cart_url) to check one. "
  + "Checkout is never completed here and no card data passes through — the link hands the shopper back to the store.";

/** The one true argument contract. Mirrors what runTool() actually dispatches
 * on (SUPPORTED_ACTIONS), so a new action cannot be added to the service
 * without showing up here. */
export const TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...SUPPORTED_ACTIONS] },
    query: { type: "string", maxLength: 200, description: "search_products only" },
    page: { type: "integer", minimum: 1 },
    per_page: { type: "integer", minimum: 1, maximum: 20 },
    product_id: { type: "integer", minimum: 1, description: "get_offer and create_cart_link" },
    quantity: { type: "integer", minimum: 1 },
    cart_url: { type: "string", description: "verify_cart_link only" },
  },
  required: ["action"],
  additionalProperties: false,
};

const OUTPUT_SCHEMA:Record<string,unknown>={"type":"object","properties":{},"additionalProperties":true};

export interface McpCallRequest {
  tool: string;
  input: ToolInput;
  identity?: string;
  paymentReference?: string;
  requestId?: string;
}

export async function handleMcpCall(
  guard: RevenueGuard, req: McpCallRequest, pricePerCall: number, productId: string,
  configOverride?: ServiceConfig,
): Promise<{ result?: unknown; error?: string; stage?: string; x402Version?:number; accepts?:unknown[]; _paymentResponse?:unknown }> {
  if (req.tool !== TOOL_NAME) {
    return { error: `unknown tool: ${req.tool}`, stage: "auth" };
  }
  const outcome = await guard.processRequest({
    productId,
    identityKind: "api_key",
    identityValue: req.identity ?? "anonymous",
    authenticated: true,
    requestPayload: req.input,
    pricePerCall,
    // A free call must also cost nothing upstream, which this one genuinely
    // does: the readiness scan reads the store being scanned, not a metered
    // API. The guard refuses a zero price paired with a non-zero cost, and
    // it is right to — that pairing is a service giving away someone else's
    // bill.
    estimatedCost: pricePerCall === 0 ? 0 : estimateCost(req.input),
    paymentReference: req.paymentReference,
    requestId: req.requestId,
    upstreamName: productId,
    upstream: () => runTool(req.input, configOverride),
// Measured to match the estimate, for the same reason. Left as the flat
    // figure it would run the scan and then withhold the result, because the
    // authorized ceiling on a free call is zero — the request succeeds
    // upstream and fails at release, which is the worst shape a bug can take:
    // the work is done, the merchant's store has been read, and the caller
    // gets an error.
    actualCost: pricePerCall === 0 ? () => 0 : measureActualCost,
    outputSchema: OUTPUT_SCHEMA,
  });
  if (!outcome.allowed) {
    return { error: outcome.reason, stage: outcome.stageReached,
      ...(outcome.paymentRequirement ? { x402Version:2, accepts:[outcome.paymentRequirement] } : {}) };
  }
  return { result: outcome.result, _paymentResponse:outcome.paymentResponse };
}
