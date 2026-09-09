export const ENDPOINT: string;
export const FAMILIES: Set<string>;
export interface ActionInputs { origin: string; families: string[]; failOnHold: boolean; }
export interface ActionResult { decision: string; state: string; unknowns: string[]; checks: unknown[]; }
export function parseInputs(env?: Record<string, string | undefined>): ActionInputs;
export function decisionFor(state: string): "RELEASE" | "HOLD" | "PARTIAL" | "ABSTAIN";
export function runAction(options?: {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  append?: (path: string, body: string, encoding?: string) => Promise<unknown>;
}): Promise<ActionResult>;
