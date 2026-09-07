import { RELEASE_FAMILIES, type AcceptanceRunInput, type PreflightInput, type ReleaseFamily } from "./types.ts";

export class ContractError extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; } }
const families = new Set<string>(RELEASE_FAMILIES);
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
function rejectExtras(input: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new ContractError("UNKNOWN_PROPERTY");
}
function string(input: Record<string, unknown>, key: string, min: number, max: number): string {
  const value = input[key];
  if (typeof value !== "string" || value.length < min || value.length > max) throw new ContractError(`INVALID_${key.toUpperCase()}`);
  return value;
}
function familyList(value: unknown, required: boolean): ReleaseFamily[] {
  if (value === undefined && !required) return [...RELEASE_FAMILIES];
  if (!Array.isArray(value) || value.length < 1 || value.length > RELEASE_FAMILIES.length || value.some(v => typeof v !== "string" || !families.has(v))) throw new ContractError("INVALID_REQUESTED_FAMILIES");
  return [...new Set(value)] as ReleaseFamily[];
}
export function parsePreflightInput(value: unknown): PreflightInput {
  if (!isObject(value)) throw new ContractError("INVALID_BODY");
  rejectExtras(value, ["store_origin", "requested_families"]);
  return { store_origin: string(value, "store_origin", 8, 2048), requested_families: familyList(value.requested_families, false) };
}
export function parseAcceptanceRunInput(value: unknown): AcceptanceRunInput {
  if (!isObject(value)) throw new ContractError("INVALID_BODY");
  rejectExtras(value, ["store_id", "mode", "requested_families", "baseline_run_id", "idempotency_key"]);
  const mode = string(value, "mode", 1, 40);
  if (mode !== "owned-safe-active") throw new ContractError("INVALID_MODE");
  const baseline = value.baseline_run_id;
  if (baseline !== undefined && (typeof baseline !== "string" || baseline.length < 8 || baseline.length > 100)) throw new ContractError("INVALID_BASELINE_RUN_ID");
  return { store_id: string(value, "store_id", 8, 100), mode, requested_families: familyList(value.requested_families, true), baseline_run_id: baseline, idempotency_key: string(value, "idempotency_key", 16, 200) };
}
export const PRELIGHT_INPUT_SCHEMA = { type: "object", additionalProperties: false, required: ["store_origin"], properties: { store_origin: { type: "string", minLength: 8, maxLength: 2048 }, requested_families: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", enum: [...RELEASE_FAMILIES] } } } };
export const ACCEPTANCE_INPUT_SCHEMA = { type: "object", additionalProperties: false, required: ["store_id", "mode", "requested_families", "idempotency_key"], properties: { store_id: { type: "string", minLength: 8, maxLength: 100 }, mode: { const: "owned-safe-active" }, requested_families: { type: "array", minItems: 1, maxItems: 6, items: { type: "string", enum: [...RELEASE_FAMILIES] } }, baseline_run_id: { type: "string", minLength: 8, maxLength: 100 }, idempotency_key: { type: "string", minLength: 16, maxLength: 200 } } };
