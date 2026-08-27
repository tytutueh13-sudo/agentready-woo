// Cloudflare KV-backed Store — the deployment-time counterpart to MemoryStore.
// Not exercised by local `node --test` (KV only exists inside the Workers
// runtime); it exists so the deployment target is ready without any other
// code changing, per the Store interface in types.ts. NOT wired up or
// deployed automatically anywhere in this project (Phase 3 does not deploy).
import type { CacheRow, CircuitRow, FinancialOperation, FinancialOperationState,
  ResultEscrowRow, SettlementOutboxRow, SettlementOutboxStatus, Store, UsageRow } from "./types.ts";

export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export class KVStore implements Store {
  private kv: KVNamespaceLike;
  private usagePrefix: string;

  constructor(kv: KVNamespaceLike, usagePrefix = "usage:") {
    this.kv = kv;
    this.usagePrefix = usagePrefix;
  }

  async recordUsage(row: UsageRow): Promise<void> {
    const key = `${this.usagePrefix}${row.productId}:${row.occurredAt}:${Math.random()}`;
    await this.kv.put(key, JSON.stringify(row), { expirationTtl: 60 * 60 * 24 * 35 });
  }

  // A real KV-backed aggregate would use a durable object or D1 for correct
  // sums; this minimal adapter is a placeholder for future phases — deploy
  // is out of scope for Phase 3 (see README "Not implemented yet").
  async sumCost(): Promise<number> {
    return 0;
  }

  async countRequests(): Promise<number> {
    return 0;
  }

  async getCache(key: string): Promise<CacheRow | null> {
    const raw = await this.kv.get(`cache:${key}`);
    return raw ? (JSON.parse(raw) as CacheRow) : null;
  }

  async setCache(key: string, row: CacheRow): Promise<void> {
    const ttl = row.expiresAt ? Math.max(1, Math.floor((row.expiresAt - Date.now()) / 1000)) : undefined;
    await this.kv.put(`cache:${key}`, JSON.stringify(row), ttl ? { expirationTtl: ttl } : undefined);
  }

  async getCircuit(upstream: string): Promise<CircuitRow | null> {
    const raw = await this.kv.get(`circuit:${upstream}`);
    return raw ? (JSON.parse(raw) as CircuitRow) : null;
  }

  async setCircuit(upstream: string, row: CircuitRow): Promise<void> {
    await this.kv.put(`circuit:${upstream}`, JSON.stringify(row));
  }
  async reserveCost(): Promise<boolean> { return false; }
  async finalizeCost(): Promise<void> { throw new Error("KV is not an atomic financial ledger"); }
  async releaseCost(): Promise<void> { throw new Error("KV is not an atomic financial ledger"); }
  async createOperation(_row:FinancialOperation):Promise<boolean>{return false;}
  async getOperation():Promise<FinancialOperation|null>{return null;}
  async transitionOperation(_id:string,_v:number,_s:FinancialOperationState[],_n:FinancialOperationState,_p?:Partial<FinancialOperation>):Promise<boolean>{return false;}
  async saveEscrow(_row:ResultEscrowRow):Promise<boolean>{return false;} async getEscrow():Promise<ResultEscrowRow|null>{return null;} async markEscrowReleased():Promise<void>{throw new Error("KV is not durable financial escrow");}
  async createSettlementOutbox(_row:SettlementOutboxRow):Promise<boolean>{return false;} async getSettlementOutbox():Promise<SettlementOutboxRow|null>{return null;} async updateSettlementOutbox(_id:string,_s:SettlementOutboxStatus):Promise<void>{throw new Error("KV is not a durable outbox");}
  async claimRecovery():Promise<boolean>{return false;} async releaseRecovery():Promise<void>{} async recordFinancialIncident():Promise<void>{}
  async isProductHalted():Promise<boolean>{return true;}
  async reconcileOperation():Promise<{ok:boolean;detail:string}>{return{ok:false,detail:"KV cannot reconcile a financial ledger"};}
  async listOperationsForReconciliation():Promise<FinancialOperation[]>{return[];}
  async listRecoverableOperations():Promise<FinancialOperation[]>{return[];}
  async recoverExpiredSafeReservations():Promise<number>{return 0;}
  async savePaymentProof():Promise<boolean>{return false;}async getPaymentProof():Promise<string|null>{return null;}async deletePaymentProof():Promise<void>{}
  async purgeExpiredSensitiveData():Promise<number>{return 0;}
}
