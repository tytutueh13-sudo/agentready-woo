export const USAGE_SURFACES = ["mcp", "rest_preflight", "wordpress_evidence", "release_gate"] as const;
export const USAGE_CHANNELS = [
  "direct", "operator", "mcp_registry", "smithery", "glama", "mcp_directory",
  "rapidapi", "api_market", "wordpress_org", "github_marketplace", "apify",
] as const;
export const USAGE_OUTCOMES = [
  "answered", "abstained", "invalid", "refused", "rate_limited", "replay", "internal_error",
] as const;

export type UsageSurface = typeof USAGE_SURFACES[number];
export type UsageChannel = typeof USAGE_CHANNELS[number];
export type UsageOutcome = typeof USAGE_OUTCOMES[number];

const MCP_CHANNEL_PATHS: Record<string, UsageChannel> = {
  "/channels/mcp-registry/mcp": "mcp_registry",
  "/channels/smithery/mcp": "smithery",
  "/channels/glama/mcp": "glama",
  "/channels/mcp-directory/mcp": "mcp_directory",
};

const PREFLIGHT_CHANNEL_PATHS: Record<string, UsageChannel> = {
  "/channels/rapidapi/preflight": "rapidapi",
  "/channels/api-market/preflight": "api_market",
  "/channels/github-marketplace/preflight": "github_marketplace",
  "/channels/wordpress-org/preflight": "wordpress_org",
};

/** A channel-specific URL is an attribution label, not an authorization
 * credential. It never widens quota, access, output or billing. */
export function mcpChannelForPath(path: string): UsageChannel | null {
  return MCP_CHANNEL_PATHS[path] ?? null;
}

export function preflightChannelForPath(path: string): UsageChannel | null {
  return PREFLIGHT_CHANNEL_PATHS[path] ?? null;
}

/** Operator classification requires the existing operations secret. A label,
 * query parameter, User-Agent or IP can never declare itself operator. */
export function usageChannel(
  request: Request, opsToken: string | undefined, fallback: UsageChannel,
): UsageChannel {
  const configured = opsToken ?? "";
  if (configured.length < 32) return fallback;
  const supplied = request.headers.get("x-agentready-operator") ?? "";
  const expected = `Bearer ${configured}`;
  let diff = supplied.length === expected.length ? 0 : 1;
  for (let i = 0; i < Math.max(supplied.length, expected.length); i++) {
    diff |= (supplied.charCodeAt(i) || 0) ^ (expected.charCodeAt(i) || 0);
  }
  return diff === 0 ? "operator" : fallback;
}

export function classifyToolResult(ok: boolean, text: string): UsageOutcome {
  let value: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
  } catch { /* a finite fallback below is safer than retaining the text */ }
  if (value.delivery === "REPLAY" || value.code === "REPLAYED") return "replay";
  if (value.state === "UNREADABLE" || value.state === "BLOCKED" || value.state === "UNMEASURED"
      || value.code === "EVIDENCE_REQUIRED" || value.code === "RESULT_NOT_READY") return "abstained";
  if (value.code === "INVALID_INPUT" || value.code === "INVALID_BODY") return "invalid";
  if (value.code === "TARGET_RATE_LIMITED") return "rate_limited";
  if (["WORKFLOW_UNAVAILABLE", "WORKFLOW_DISPATCH_FAILED", "INFRA_PERSISTENCE_FAILED"].includes(String(value.code ?? ""))) {
    return "internal_error";
  }
  if (!ok) return "refused";
  return "answered";
}
