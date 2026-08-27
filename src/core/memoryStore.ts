import type { CacheRow, CircuitRow, FinancialOperation, FinancialOperationState,
  ResultEscrowRow, SettlementOutboxRow, SettlementOutboxStatus, Store, UsageRow } from "./types.ts";

const ALLOWED_TRANSITIONS:Record<FinancialOperationState,readonly FinancialOperationState[]>={CREATED:["COST_RESERVED","FAILED_FINAL"],COST_RESERVED:["PAYMENT_AUTHORIZED","FAILED_FINAL"],PAYMENT_AUTHORIZED:["UPSTREAM_STARTED","FAILED_FINAL"],UPSTREAM_STARTED:["RESULT_ESCROWED","RECOVERY_REQUIRED","FAILED_FINAL"],RESULT_ESCROWED:["SETTLEMENT_PENDING","SETTLED","FAILED_FINAL"],SETTLEMENT_PENDING:["SETTLEMENT_AMBIGUOUS","SETTLED","RECOVERY_REQUIRED","FAILED_FINAL"],SETTLEMENT_AMBIGUOUS:["SETTLED","RECOVERY_REQUIRED","FAILED_FINAL"],SETTLED:["RESULT_RELEASED","RECOVERY_REQUIRED"],RESULT_RELEASED:[],RECOVERY_REQUIRED:["RECOVERY_REQUIRED","SETTLED","FAILED_FINAL"],FAILED_FINAL:[]};

// In-memory Store — used for local `node --test` runs and as the default
// runtime backend. A KVStore with the same interface (backed by Cloudflare
// KV) is the deployment-time replacement; nothing else in this codebase
// needs to change to swap them (see types.ts's Store interface).
export class MemoryStore implements Store {
  private usage: UsageRow[] = [];
  private cache = new Map<string, CacheRow>();
  private circuits = new Map<string, CircuitRow>();
  private reservations = new Map<string, UsageRow>();
  private finalizedReservations = new Map<string, number>();
  private operations = new Map<string, FinancialOperation>();
  private escrows = new Map<string, ResultEscrowRow>();
  private outbox = new Map<string, SettlementOutboxRow>();
  private incidents: { operationId: string; kind: string; detail: string; createdAt: number }[] = [];
  private halts = new Map<string, { reason: string; operationId: string; createdAt: number }>();
  private paymentProofs = new Map<string, {payloadJson:string;expiresAt:number}>();
  private reservationLock: Promise<void> = Promise.resolve();

  async recordUsage(row: UsageRow): Promise<void> {
    this.usage.push(row);
  }

  async sumCost(sinceMs: number, productId?: string, identity?: [string, string]): Promise<number> {
    return this.usage
      .filter((r) => r.occurredAt >= sinceMs)
      .filter((r) => (productId ? r.productId === productId : true))
      .filter((r) => (identity ? r.identityKind === identity[0] && r.identityValue === identity[1] : true))
      .reduce((sum, r) => sum + r.cost, 0);
  }

  async countRequests(
    productId: string, identityKind: string, identityValue: string, sinceMs: number,
  ): Promise<number> {
    return this.usage.filter(
      (r) => r.productId === productId && r.identityKind === identityKind
        && r.identityValue === identityValue && r.occurredAt >= sinceMs,
    ).length;
  }

  async getCache(key: string): Promise<CacheRow | null> {
    const row = this.cache.get(key);
    if (!row) return null;
    if (row.expiresAt !== null && row.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return row;
  }

  async setCache(key: string, row: CacheRow): Promise<void> {
    this.cache.set(key, row);
  }

  async getCircuit(upstream: string): Promise<CircuitRow | null> {
    return this.circuits.get(upstream) ?? null;
  }

  async setCircuit(upstream: string, row: CircuitRow): Promise<void> {
    this.circuits.set(upstream, row);
  }

  async reserveCost(requestId: string, row: UsageRow, limits: {
    perRequest: number; daily: number; monthly: number;
    perProductDaily: number; perUserDaily: number;
  }): Promise<boolean> {
    let unlock!: () => void;
    const prior = this.reservationLock;
    this.reservationLock = new Promise<void>((resolve) => { unlock = resolve; });
    await prior;
    try {
      if (this.reservations.has(requestId) || row.cost < 0 || !Number.isFinite(row.cost)) return false;
      const now = Date.now(); const day = 86_400_000;
      const all = this.usage.concat([...this.reservations.values()]);
      const sum = (since: number, product?: string, identity?: [string, string]) => all
        .filter((item) => item.occurredAt >= since)
        .filter((item) => !product || item.productId === product)
        .filter((item) => !identity || (item.identityKind === identity[0] && item.identityValue === identity[1]))
        .reduce((total, item) => total + item.cost, 0);
      if (row.cost > limits.perRequest || sum(now-day)+row.cost > limits.daily
          || sum(now-30*day)+row.cost > limits.monthly
          || sum(now-day,row.productId)+row.cost > limits.perProductDaily
          || sum(now-day,row.productId,[row.identityKind,row.identityValue])+row.cost > limits.perUserDaily) return false;
      this.reservations.set(requestId, row); return true;
    } finally { unlock(); }
  }
  async finalizeCost(requestId: string, actualCost: number): Promise<void> {
    const row = this.reservations.get(requestId);
    if (!row) {
      if(this.finalizedReservations.get(requestId)===actualCost)return;
      throw new Error("invalid reservation finalization");
    }
    if (actualCost < 0 || !Number.isFinite(actualCost) || actualCost > row.cost) throw new Error("invalid reservation finalization");
    this.reservations.delete(requestId);this.finalizedReservations.set(requestId,actualCost);this.usage.push({ ...row, cost: actualCost });
  }
  async releaseCost(requestId: string): Promise<void> { this.reservations.delete(requestId); }
  async createOperation(row:FinancialOperation):Promise<boolean>{if(this.operations.has(row.operationId))return false;this.operations.set(row.operationId,structuredClone(row));return true;}
  async getOperation(id:string):Promise<FinancialOperation|null>{const row=this.operations.get(id);return row?structuredClone(row):null;}
  async transitionOperation(id:string,version:number,states:FinancialOperationState[],next:FinancialOperationState,patch:Partial<FinancialOperation>={}):Promise<boolean>{const row=this.operations.get(id);if(!row||row.version!==version||!states.includes(row.state)||!ALLOWED_TRANSITIONS[row.state].includes(next))return false;this.operations.set(id,{...row,...structuredClone(patch),operationId:row.operationId,state:next,version:version+1,updatedAt:Date.now()});return true;}
  async saveEscrow(row:ResultEscrowRow):Promise<boolean>{if(this.escrows.has(row.operationId))return false;this.escrows.set(row.operationId,structuredClone(row));return true;}
  async getEscrow(id:string):Promise<ResultEscrowRow|null>{const row=this.escrows.get(id);return row?structuredClone(row):null;}
  async markEscrowReleased(id:string,at:number):Promise<void>{const row=this.escrows.get(id);if(row)this.escrows.set(id,{...row,releasedAt:at});}
  async createSettlementOutbox(row:SettlementOutboxRow):Promise<boolean>{if(this.outbox.has(row.settlementId))return false;this.outbox.set(row.settlementId,structuredClone(row));return true;}
  async getSettlementOutbox(id:string):Promise<SettlementOutboxRow|null>{const row=this.outbox.get(id);return row?structuredClone(row):null;}
  async updateSettlementOutbox(id:string,status:SettlementOutboxStatus,error="",providerReference=""):Promise<void>{const row=this.outbox.get(id);if(row)this.outbox.set(id,{...row,status,lastErrorCode:error,providerReference:providerReference||row.providerReference,attemptCount:row.attemptCount+1,lastAttemptAt:Date.now(),updatedAt:Date.now()});}
  async claimRecovery(id:string,owner:string,now:number,until:number):Promise<boolean>{const row=this.operations.get(id);if(!row||(row.recoveryLeaseUntil>now&&row.recoveryOwner!==owner))return false;this.operations.set(id,{...row,recoveryOwner:owner,recoveryLeaseUntil:until,version:row.version+1,updatedAt:now});return true;}
  async releaseRecovery(id:string,owner:string):Promise<void>{const row=this.operations.get(id);if(row?.recoveryOwner===owner)this.operations.set(id,{...row,recoveryOwner:"",recoveryLeaseUntil:0,version:row.version+1,updatedAt:Date.now()});}
  async recordFinancialIncident(id:string,kind:string,detail:string):Promise<void>{this.incidents.push({operationId:id,kind,detail,createdAt:Date.now()});}
  incidentsFor(id:string):{operationId:string;kind:string;detail:string;createdAt:number}[]{return this.incidents.filter(row=>row.operationId===id).map(row=>({...row}));}
  async isProductHalted(productId:string):Promise<boolean>{return this.halts.has(productId);}
  // Mirrors D1FinancialStore.reconcileOperation so a MemoryStore-backed test
  // can observe a halt instead of silently reporting healthy.
  async reconcileOperation(id:string):Promise<{ok:boolean;detail:string}>{
    const op=this.operations.get(id);if(!op)return{ok:false,detail:"operation missing"};
    const problems:string[]=[];
    if(!Number.isFinite(op.reservedAmount)||op.reservedAmount<0)problems.push("invalid reserved amount");
    if(op.actualCost!==null&&(!Number.isFinite(op.actualCost)||op.actualCost<0||op.actualCost>op.reservedAmount))problems.push("actual cost violates reservation");
    const active=["COST_RESERVED","PAYMENT_AUTHORIZED","UPSTREAM_STARTED","RESULT_ESCROWED","SETTLEMENT_PENDING","SETTLEMENT_AMBIGUOUS","RECOVERY_REQUIRED"].includes(op.state);
    const reserved=this.reservations.get(op.reservationId);
    if(active&&(!reserved||Math.abs(reserved.cost-op.reservedAmount)>1e-9))problems.push("active reservation mismatch");
    if(["SETTLED","RESULT_RELEASED"].includes(op.state)){
      const finalized=this.finalizedReservations.get(op.reservationId);
      if(op.actualCost===null||finalized===undefined||Math.abs(finalized-op.actualCost)>1e-9)problems.push("finalized cost mismatch");
      else if(op.reservedAmount-op.actualCost<-1e-9)problems.push("released amount is negative");
    }
    if(problems.length===0)return{ok:true,detail:"conserved"};
    const detail=problems.join("; ");
    await this.recordFinancialIncident(id,"FINANCIAL_LEDGER_MISMATCH",detail);
    this.halts.set(op.productId,{reason:"FINANCIAL_LEDGER_MISMATCH",operationId:id,createdAt:Date.now()});
    return{ok:false,detail};
  }
  haltRecord(productId:string):{reason:string;operationId:string;createdAt:number}|null{return this.halts.get(productId)??null;}
  async listOperationsForReconciliation(limit:number):Promise<FinancialOperation[]>{return[...this.operations.values()].filter(row=>["SETTLED","RESULT_RELEASED","FAILED_FINAL"].includes(row.state)).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,limit).map(row=>structuredClone(row));}
  async listRecoverableOperations(limit:number):Promise<FinancialOperation[]>{return[...this.operations.values()].filter(row=>["UPSTREAM_STARTED","RESULT_ESCROWED","SETTLEMENT_PENDING","SETTLEMENT_AMBIGUOUS","SETTLED","RECOVERY_REQUIRED"].includes(row.state)).sort((a,b)=>a.updatedAt-b.updatedAt).slice(0,limit).map(row=>structuredClone(row));}
  async recoverExpiredSafeReservations(cutoff:number):Promise<number>{let recovered=0;for(const [id,row]of this.operations){if(row.updatedAt<cutoff&&["CREATED","COST_RESERVED","PAYMENT_AUTHORIZED"].includes(row.state)){this.operations.set(id,{...row,state:"FAILED_FINAL",errorCode:"EXPIRED_SAFE_RESERVATION",version:row.version+1,updatedAt:Date.now()});this.reservations.delete(row.reservationId);recovered++;}}return recovered;}
  async savePaymentProof(id:string,payloadJson:string,expiresAt:number):Promise<boolean>{if(this.paymentProofs.has(id))return false;this.paymentProofs.set(id,{payloadJson,expiresAt});return true;}
  async getPaymentProof(id:string):Promise<string|null>{const row=this.paymentProofs.get(id);return row&&row.expiresAt>Date.now()?row.payloadJson:null;}
  async deletePaymentProof(id:string):Promise<void>{this.paymentProofs.delete(id);}
  async purgeExpiredSensitiveData(now:number):Promise<number>{let purged=0;for(const[id,row]of this.paymentProofs){if(row.expiresAt<=now){this.paymentProofs.delete(id);purged++;}}for(const[id,row]of this.escrows){if(row.releasedAt!==null&&row.expiresAt<=now){this.escrows.delete(id);purged++;}}return purged;}
}
