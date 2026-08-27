// HTTP API handler — reuses the exact same runTool()/estimateCost() core as
// mcp.ts (section 21: one service layer, not two).
import { runTool, estimateCost, measureActualCost, type ToolInput } from "./service.ts";
import { RevenueGuard } from "./core/guard.ts";
import type { ServiceConfig } from "./service.ts";

export const API_PATH = "/api/v1/agentready_woo_agentic_commerce_readiness_toolkit_for_self_h";
const OUTPUT_SCHEMA:Record<string,unknown>={"type":"object","additionalProperties":true};

export interface ApiCallRequest {
  input: ToolInput;
  identity?: string;
  paymentReference?: string;
  requestId?: string;
}

export async function handleApiCall(
  guard: RevenueGuard, req: ApiCallRequest, pricePerCall: number, productId: string,
  configOverride?: ServiceConfig,
): Promise<{ status: number; body: unknown; paymentResponse?:unknown }> {
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
    const status = outcome.stageReached === "auth" ? 401
      : outcome.stageReached === "payment" ? 402
      : outcome.stageReached === "rate_limit" ? 429
      : outcome.stageReached === "budget" || outcome.stageReached === "quota" ? 503
      : 400;
    return { status, body: { error: outcome.reason, stage: outcome.stageReached,
      ...(outcome.paymentRequirement ? { x402Version:2, accepts:[outcome.paymentRequirement] } : {}) } };
  }
  return { status: 200, body: outcome.result, paymentResponse:outcome.paymentResponse };
}
