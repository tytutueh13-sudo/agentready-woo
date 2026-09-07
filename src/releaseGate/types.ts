/** Shared, transport-neutral Release Gate contract.  No value in this file is
 * an upstream body, a secret, or a merchant/customer identifier. */
export const RELEASE_FAMILIES = ["woo", "robots", "jsonld", "mcp", "ucp", "acp"] as const;
export type ReleaseFamily = typeof RELEASE_FAMILIES[number];
export const RELEASE_STATES = ["ACCEPTED", "REJECTED", "PARTIAL", "BLOCKED", "UNMEASURED", "INFRA_ERROR", "CANCELED"] as const;
export type ReleaseState = typeof RELEASE_STATES[number];
export const CHECK_STATES = ["PASS", "FAIL", "BLOCKED", "NOT_APPLICABLE", "UNMEASURED"] as const;
export type CheckState = typeof CHECK_STATES[number];

export type ReasonCode =
  | "TARGET_INVALID" | "TARGET_PRIVATE" | "TARGET_REDIRECT_UNSAFE" | "TARGET_DNS_REBIND"
  | "TARGET_TIMEOUT" | "TARGET_BYTES_EXCEEDED" | "TARGET_RATE_LIMITED" | "ROBOTS_BLOCKED"
  | "WOO_API_UNAVAILABLE" | "WOO_SAMPLE_EMPTY" | "JSONLD_PRODUCT_MISSING" | "JSONLD_OFFER_MISSING"
  | "DISCOVERY_UNDECLARED" | "PROTOCOL_VERSION_UNSUPPORTED" | "PROTOCOL_SCHEMA_INVALID"
  | "MCP_INITIALIZE_FAILED" | "MCP_TOOLS_LIST_FAILED" | "MCP_TOOL_ANNOTATION_UNSAFE"
  | "MCP_TOOL_CALL_FAILED" | "UCP_PROFILE_INVALID" | "ACP_PROFILE_INVALID"
  | "CROSS_SURFACE_CONFLICT" | "OWNERSHIP_REQUIRED" | "OWNERSHIP_EXPIRED"
  | "ACTIVE_FLOW_FORBIDDEN" | "EVIDENCE_INVALID" | "INFRA_PERSISTENCE_FAILED"
  | "UNMEASURED_SOURCE" | "CONNECTION_UNVERIFIABLE" | "INVALID_MIME"
  | "INVALID_JSON" | "PAGINATION_DRIFT" | "CANCELED_BY_CALLER";

export interface ReleaseCheck {
  id: string; family: ReleaseFamily; state: CheckState; reasonCode?: ReasonCode;
  evidence: Record<string, string | number | boolean | null>;
}
export interface ProtocolBundle {
  family: "mcp" | "ucp" | "acp"; release: string; sourceUrl: string;
  sourceSha256: string; vectorSha256: string; builtAt: string;
  supportedVectors: readonly string[]; unsupportedVectors: readonly string[];
}
export interface PreflightInput { store_origin: string; requested_families?: ReleaseFamily[]; }
export interface PreflightResult {
  kind: "preflight"; state: Exclude<ReleaseState, "CANCELED" | "INFRA_ERROR">;
  store_origin: string; requested_families: ReleaseFamily[]; sample_seed: string; sample_size: number;
  catalogue_total: number | null; checks: ReleaseCheck[]; protocol_bundles: ProtocolBundle[];
  observed_at: string; unknowns: ReasonCode[];
}
export interface AcceptanceRunInput {
  store_id: string; mode: "owned-safe-active"; requested_families: ReleaseFamily[];
  baseline_run_id?: string; idempotency_key: string;
}
export interface AcceptanceRun {
  id: string; accountId: string; storeId: string; mode: "owned-safe-active";
  requestedFamilies: ReleaseFamily[]; baselineRunId: string | null; idempotencyKey: string;
  state: "QUEUED" | "RUNNING" | "RETRYING" | "TERMINAL" | "CANCELED";
  terminalState: ReleaseState | null; createdAt: number; updatedAt: number;
  bundleDigest: string; evidenceDigest: string | null;
}
export interface EvidencePacket {
  schema_version: "2026-09-06"; run_id: string; state: ReleaseState;
  checks: ReleaseCheck[]; protocol_bundles: Array<Pick<ProtocolBundle, "family" | "release" | "sourceSha256" | "vectorSha256" | "builtAt">>;
  coverage: { requested_families: ReleaseFamily[]; completed_families: ReleaseFamily[]; sample_size: number; catalogue_total: number | null };
  unknowns: ReasonCode[]; observed_at: string; digest: string;
}
export const BILLABLE_TERMINAL = new Set<ReleaseState>(["ACCEPTED", "REJECTED"]);
export function isBillableTerminal(state: ReleaseState | null): boolean { return state !== null && BILLABLE_TERMINAL.has(state); }
