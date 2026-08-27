// Minimal MCP-*shaped* tool endpoint: accepts { tool, input }, returns
// { result } or { error }. NOT a full JSON-RPC 2.0 MCP protocol
// implementation (see README.md "Not implemented yet" — wiring the official
// @modelcontextprotocol/sdk framing is a follow-up task).
import { runTool, estimateCost, measureActualCost, type ToolInput , type ServiceConfig } from "./service.ts";
import { RevenueGuard } from "./core/guard.ts";
import type { PaymentProvider } from "./core/paymentProvider.ts";

export const TOOL_NAME = "agentready_woo_agentic_commerce_readiness_toolkit_for_self_h";
export const TOOL_DESCRIPTION = "A deploy-once Cloudflare Worker + MCP server that connects to a store's existing WooCommerce REST API (the merchant's own infra, no per-call upstream cost) and exposes: (1) an agent-readable product feed generated from the live catalog; (2) /.well-known/agenticweb.md discovery metadata so agents can find capabilities; (3) an MCP tool surface agents can call (search products, get offer details, create signed cart links); (4) a dashboard showing agent traffic and missed opportunities. Checkout stays human-approved through signed cart links completed in the buyer's browser — no card data ever touches the service.";
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
    estimatedCost: estimateCost(req.input),
    paymentReference: req.paymentReference,
    requestId: req.requestId,
    upstreamName: productId,
    upstream: () => runTool(req.input, configOverride),
    actualCost: measureActualCost,
    outputSchema: OUTPUT_SCHEMA,
  });
  if (!outcome.allowed) {
    return { error: outcome.reason, stage: outcome.stageReached,
      ...(outcome.paymentRequirement ? { x402Version:2, accepts:[outcome.paymentRequirement] } : {}) };
  }
  return { result: outcome.result, _paymentResponse:outcome.paymentResponse };
}
