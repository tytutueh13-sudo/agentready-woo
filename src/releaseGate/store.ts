import type { AppStore, ReleaseGateRunRow } from "../core/appStore.ts";
import { bundleDigest } from "./protocolBundles.ts";
import { sha256 } from "./evidence.ts";
import type { AcceptanceRun, AcceptanceRunInput, EvidencePacket, ReleaseState } from "./types.ts";

const mapRun = (row: ReleaseGateRunRow): AcceptanceRun => ({ id: row.id, accountId: row.accountId, storeId: row.storeId, mode: row.mode, requestedFamilies: JSON.parse(row.requestedFamiliesJson), baselineRunId: row.baselineRunId, idempotencyKey: row.idempotencyKey, state: row.state, terminalState: row.terminalState as ReleaseState | null, createdAt: row.createdAt, updatedAt: row.updatedAt, bundleDigest: row.bundleDigest, evidenceDigest: row.evidenceDigest });
export async function deriveOwnershipKey(ownershipSecret: string, storeId: string): Promise<string> {
  const root = await crypto.subtle.importKey("raw", new TextEncoder().encode(ownershipSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", root, new TextEncoder().encode(`agentready-release-gate:${storeId}`));
  return [...new Uint8Array(derived)].map(value => value.toString(16).padStart(2, "0")).join("");
}
export class ReleaseGateStore {
  private readonly app: AppStore;
  constructor(app: AppStore) { this.app = app; }
  async createChallenge(storeId: string, accountId: string): Promise<{ id: string; challenge: string; expiresAt: number }> { const id = crypto.randomUUID(); const challenge = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, ""); const expiresAt = Date.now() + 15 * 60_000; await this.app.createReleaseChallenge(id,storeId,accountId,await sha256(challenge),expiresAt); return { id, challenge, expiresAt }; }
  async verifyChallenge(id: string, storeId: string, accountId: string, challenge: string, proof: string, ownershipSecret: string): Promise<boolean> {
    if (!ownershipSecret || challenge.length < 32 || proof.length !== 64) return false;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(await deriveOwnershipKey(ownershipSecret, storeId)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(challenge));
    const expected = [...new Uint8Array(signature)].map(v => v.toString(16).padStart(2, "0")).join("");
    let equal = expected.length === proof.length ? 0 : 1; for (let i = 0; i < Math.max(expected.length, proof.length); i++) equal |= (expected.charCodeAt(i) || 0) ^ (proof.charCodeAt(i) || 0);
    return equal === 0 && await this.app.verifyReleaseChallenge(id,storeId,accountId,await sha256(challenge));
  }
  async createOrGetRun(accountId: string, input: AcceptanceRunInput): Promise<AcceptanceRun> { const row = await this.app.createOrGetReleaseRun({ id: crypto.randomUUID(), accountId, storeId: input.store_id, mode: input.mode, requestedFamiliesJson: JSON.stringify(input.requested_families), baselineRunId: input.baseline_run_id ?? null, idempotencyKey: input.idempotency_key, state: "QUEUED", bundleDigest: await bundleDigest() }); return mapRun(row); }
  async getRun(id: string, accountId: string): Promise<AcceptanceRun | null> { const row = await this.app.getReleaseRun(id,accountId); return row ? mapRun(row) : null; }
  async markDispatchFailed(run: AcceptanceRun): Promise<boolean> { return this.app.markReleaseDispatchFailed(run.id,run.accountId); }
  async publish(run: AcceptanceRun, state: ReleaseState, packetJson: string, digest: string): Promise<boolean> { return this.app.publishReleaseResult(run.id,run.accountId,state,digest,packetJson); }
  async setBaseline(run: AcceptanceRun): Promise<void> { await this.app.setReleaseBaseline(run.storeId,run.bundleDigest,run.id); }
  async claim(run: AcceptanceRun, channel: string, identity: string): Promise<{ firstDelivery: boolean; billable: boolean; packet: EvidencePacket | null }> { const packetJson = await this.app.getReleaseEvidence(run.id); const packet = packetJson ? JSON.parse(packetJson) as EvidencePacket : null; const terminal=run.terminalState === "ACCEPTED" || run.terminalState === "REJECTED"; const result=packet?await this.app.claimReleaseDelivery(run.id,channel,identity,terminal):{firstDelivery:false,eligible:false}; return { firstDelivery: result.firstDelivery, billable: result.eligible, packet }; }
}
