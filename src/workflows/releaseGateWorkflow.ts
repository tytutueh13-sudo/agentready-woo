import type { WorkflowEntrypoint as WorkflowEntrypointType, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { AppStore } from "../core/appStore.ts";
import type { D1DatabaseLike } from "../core/d1Store.ts";
import { ReleaseGateStore } from "../releaseGate/store.ts";
import { validatePluginEvidence } from "../releaseGate/pluginEvidence.ts";
import { evidenceCoversFamilies } from "../releaseGate/signedEvidence.ts";
import { executeSignedEvidenceRun } from "./acceptanceRun.ts";

export interface ReleaseGateWorkflowEnv { FINANCIAL_DB?: D1DatabaseLike; }
export interface ReleaseGateWorkflowInput { runId: string; }

/** Shared by the Cloudflare Workflow entrypoint and the local production
 * harness. It has no fetch dependency: signed, committed evidence is the
 * only admissible source for a paid decision. */
export async function runReleaseGateWorkflow(app:AppStore,runId:string,now=Date.now()):Promise<"published"|"already-terminal"|"evidence-unavailable"> {
  const row=await app.getReleaseRunForWorkflow(runId);if(!row||row.state==="TERMINAL"||row.state==="CANCELED")return"already-terminal";
  const runStore=new ReleaseGateStore(app);const run=await runStore.getRun(row.id,row.accountId);if(!run)throw new Error("run missing");const generation=await app.getActivePluginEvidence(run.storeId,run.accountId,now);if(!generation)return"evidence-unavailable";
  const packet=await validatePluginEvidence(JSON.parse(generation.safePacket),now);if(packet.digest!==generation.digest||!evidenceCoversFamilies(packet,run.requestedFamilies))return"evidence-unavailable";
  await executeSignedEvidenceRun(run,packet,runStore);return"published";
}

/** A durable Cloudflare Workflow, not a request-side fire-and-forget promise.
 * The network guard intentionally has no connection-binding adapter in a
 * Worker runtime, so active network checks publish BLOCKED evidence rather
 * than making an unprovable outbound connection claim. */
/* Node's test runner cannot resolve the Worker-only module. The dynamic import
 * is evaluated only in the Worker runtime; Wrangler still receives the native
 * WorkflowEntrypoint base there. */
const WorkflowEntrypointBase = (typeof process === "undefined"
  ? (await import("cloudflare:workers")).WorkflowEntrypoint
  : class {}) as typeof WorkflowEntrypointType;
export class ReleaseGateAcceptanceWorkflow extends WorkflowEntrypointBase<ReleaseGateWorkflowEnv, ReleaseGateWorkflowInput> {
  async run(event: Readonly<WorkflowEvent<ReleaseGateWorkflowInput>>, step: WorkflowStep): Promise<void> {
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(event.payload.runId)) throw new Error("invalid workflow run id");
    const claimed=await step.do("release-gate-claim-run", { retries: { limit: 2, delay: "5 seconds", backoff: "constant" }, timeout: "30 seconds" }, async () => {
      if(!this.env.FINANCIAL_DB)throw new Error("release gate D1 unavailable");return await new AppStore(this.env.FINANCIAL_DB).claimReleaseRunForWorkflow(event.payload.runId);
    });
    if(!claimed)return;
    await step.do("release-gate-collect-verify-publish", { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "60 seconds" }, async () => {
      if (!this.env.FINANCIAL_DB) throw new Error("release gate D1 unavailable");
      const app = new AppStore(this.env.FINANCIAL_DB);
      return await runReleaseGateWorkflow(app,event.payload.runId);
    });
  }
}
