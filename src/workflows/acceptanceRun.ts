import { classify } from "../releaseGate/classifier.ts";
import { createEvidencePacket, evidenceIsSafe } from "../releaseGate/evidence.ts";
import { bundlesFor } from "../releaseGate/protocolBundles.ts";
import { runPreflight, type PreflightDependencies } from "../releaseGate/preflight.ts";
import type { AcceptanceRun, ReleaseCheck, ReleaseState } from "../releaseGate/types.ts";
import type { PluginEvidence } from "../releaseGate/pluginEvidence.ts";
import { pluginEvidenceChecks } from "../releaseGate/signedEvidence.ts";

export interface ActiveFlow {
  /** The flow itself must prove it cannot order, reserve stock, notify a
   * customer, or handle payments. The executor rejects any other shape. */
  readonly sideEffects: "ephemeral-session-only";
  run(): Promise<ReleaseCheck[]>;
}
export interface AcceptancePersistence { publish(run: AcceptanceRun, state: ReleaseState, packetJson: string, digest: string): Promise<boolean>; setBaseline(run: AcceptanceRun): Promise<void>; }
export interface WorkflowExecutor { create(input: { params: { runId: string } }): Promise<unknown>; }
export async function executeAcceptanceRun(run: AcceptanceRun, storeOrigin: string, persistence: AcceptancePersistence, deps: PreflightDependencies, active?: ActiveFlow): Promise<ReleaseState> {
  const preflight = await runPreflight({ store_origin: storeOrigin, requested_families: run.requestedFamilies }, deps);
  const checks = [...preflight.checks];
  if (active) {
    if (active.sideEffects !== "ephemeral-session-only") checks.push({ id: "active-flow-barrier", family: "woo", state: "BLOCKED", reasonCode: "ACTIVE_FLOW_FORBIDDEN", evidence: { allowed: false } });
    else checks.push(...await active.run());
  } else checks.push({ id: "active-flow", family: "woo", state: "UNMEASURED", reasonCode: "UNMEASURED_SOURCE", evidence: { authorized: false } });
  const state = preflight.state === "BLOCKED" ? "BLOCKED" : classify(checks, run.requestedFamilies);
  const packet = await createEvidencePacket(run.id, state, checks, bundlesFor(run.requestedFamilies), run.requestedFamilies, preflight.sample_size, preflight.catalogue_total, preflight.unknowns);
  if (!evidenceIsSafe(packet)) throw new Error("unsafe evidence packet");
  const published = await persistence.publish(run, state, JSON.stringify(packet), packet.digest); if (!published) throw new Error("evidence publication failed");
  if (state === "ACCEPTED") await persistence.setBaseline(run);
  return state;
}

/** Production Release Gate execution consumes a committed plugin generation;
 * it deliberately performs no URL fetches. */
export async function executeSignedEvidenceRun(run:AcceptanceRun,packet:PluginEvidence,persistence:AcceptancePersistence):Promise<ReleaseState>{
  const checks=pluginEvidenceChecks(packet,run.requestedFamilies);const state=classify(checks,run.requestedFamilies);
  const evidence=await createEvidencePacket(run.id,state,checks,bundlesFor(run.requestedFamilies),run.requestedFamilies,0,null,checks.filter(c=>c.state==="UNMEASURED").map(c=>c.reasonCode!).filter(Boolean));
  if(!evidenceIsSafe(evidence))throw new Error("unsafe evidence packet");if(!await persistence.publish(run,state,JSON.stringify(evidence),evidence.digest))throw new Error("evidence publication failed");if(state==="ACCEPTED")await persistence.setBaseline(run);return state;
}
