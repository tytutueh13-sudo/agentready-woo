import type { ReleaseCheck, ReleaseFamily, ReleaseState } from "./types.ts";
/** No score or model may override this precedence. A required unmeasured
 * family is never accepted, and only a complete pass can be ACCEPTED. */
export function classify(checks: readonly ReleaseCheck[], required: readonly ReleaseFamily[]): ReleaseState {
  if (!checks.length) return "UNMEASURED";
  if (checks.some(c => c.state === "BLOCKED")) return "BLOCKED";
  if (checks.some(c => c.state === "UNMEASURED")) return "UNMEASURED";
  if (checks.some(c => c.state === "FAIL")) return "REJECTED";
  const measured = new Set(checks.filter(c => c.state !== "NOT_APPLICABLE").map(c => c.family));
  if (required.some(f => !measured.has(f))) return "PARTIAL";
  return "ACCEPTED";
}
