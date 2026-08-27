// Revenue Guard with a D1-backed operation state machine. "Exactly once
// execution" is not claimed: the contract is at-most-once external effect,
// idempotent replay, durable recovery, and explicit unknown financial state.
import { CircuitBreaker } from "./circuitBreaker.ts";
import { ResponseCache } from "./cache.ts";
import { NullEventSink } from "./eventSink.ts";
import { RateLimiter } from "./limiter.ts";
import { checkPrice, type RevenueGuardConfig } from "./pricing.ts";
import type { PaymentProvider, PaymentRequirement } from "./paymentProvider.ts";
import { QuotaTracker } from "./quota.ts";
import type {
  EventSink, FinancialOperation, FinancialOperationState, GuardOutcome, GuardStage,
  PaymentRequirementPublic, RequestContext, ResultEscrowRow, SettlementOutboxRow, Store,
} from "./types.ts";

export interface KillSwitchEnv {
  REVENUE_SYSTEM_ENABLED?: string;
  REAL_PAYMENTS_ENABLED?: string;
  [key: string]: string | undefined; // PRODUCT_<id>_ENABLED lives here too
}

function flagDisabled(value: string | undefined): boolean {
  return value !== undefined && ["false", "0", "no", "off"].includes(value.trim().toLowerCase());
}

export interface FaultInjector { checkpoint(name:string):void; }
const SECRET_KEY=/(^|_)(authorization|credential|mnemonic|password|private|secret|token|api_key)($|_)/i;
function schemaAccepts(value:unknown,schema:Record<string,unknown>,path="result"):void{const type=schema.type;if(type==="object"){if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(`${path} violates output schema`);const properties=schema.properties&&typeof schema.properties==="object"?schema.properties as Record<string,Record<string,unknown>>:{};const required=Array.isArray(schema.required)?schema.required:[];for(const key of required)if(typeof key==="string"&&!(key in value))throw new Error(`${path}.${key} is required`);for(const [key,child]of Object.entries(value)){if(properties[key])schemaAccepts(child,properties[key],`${path}.${key}`);else if(schema.additionalProperties===false)throw new Error(`${path}.${key} is not allowed`);}}else if(type==="array"){if(!Array.isArray(value))throw new Error(`${path} violates output schema`);if(schema.items&&typeof schema.items==="object")value.forEach((child,index)=>schemaAccepts(child,schema.items as Record<string,unknown>,`${path}[${index}]`));}else if(type==="string"&&typeof value!=="string")throw new Error(`${path} violates output schema`);else if(type==="number"&&(typeof value!=="number"||!Number.isFinite(value)))throw new Error(`${path} violates output schema`);else if(type==="integer"&&(typeof value!=="number"||!Number.isInteger(value)))throw new Error(`${path} violates output schema`);else if(type==="boolean"&&typeof value!=="boolean")throw new Error(`${path} violates output schema`);}
function safeResultJson(result:unknown,schema?:Record<string,unknown>):string{
  if(schema)schemaAccepts(result,schema);
  const json=JSON.stringify(result,(key,value)=>{if(key&&SECRET_KEY.test(key))throw new Error("result contains a secret-shaped field");return value;});
  if(json===undefined)throw new Error("result is not JSON serializable");
  const size=new TextEncoder().encode(json).length;if(size>262_144)throw new Error("result exceeds durable escrow size limit");
  return json;
}
async function digestText(value:string):Promise<string>{const bytes=new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)));return[...bytes].map(v=>v.toString(16).padStart(2,"0")).join("");}

export class RevenueGuard {
  private store: Store;
  private guard: RevenueGuardConfig;
  private paymentProvider: PaymentProvider | null;
  private rateLimiter: RateLimiter;
  private quota: QuotaTracker;
  private cache: ResponseCache;
  private circuit: CircuitBreaker;
  private env: KillSwitchEnv;
  private events: EventSink;
  private faults: FaultInjector | null;

  constructor(
    store: Store, guard: RevenueGuardConfig, paymentProvider: PaymentProvider | null,
    env: KillSwitchEnv, events: EventSink = new NullEventSink(), faults:FaultInjector|null=null,
  ) {
    this.store = store;
    this.guard = guard;
    this.paymentProvider = paymentProvider;
    this.env = env;
    this.events = events;
    this.faults = faults;
    this.rateLimiter = new RateLimiter(store, guard);
    this.quota = new QuotaTracker(store, guard);
    this.cache = new ResponseCache(store, guard);
    this.circuit = new CircuitBreaker(store, guard);
  }

  private checkpoint(name:string):void{this.faults?.checkpoint(name);}
  // H-01: every operation is recovered in isolation. A throw from one obligation
  // is recorded and quarantined, never allowed to abort the sweep and strand the
  // settlement obligations queued behind it.
  async recoverPending(limit=50):Promise<{scanned:number;resolved:number;failed:number}>{
    const operations=await this.store.listRecoverableOperations(limit);let resolved=0;let failed=0;
    for(const operation of operations){
      try{const outcome=await this.recoverOperation(operation,[]);if(outcome.allowed)resolved++;}
      catch(error){failed++;await this.quarantineOperation(operation,error instanceof Error?error.message:String(error));}
    }
    return{scanned:operations.length,resolved,failed};
  }

  // Failure is left in an explicit, fail-closed state with an incident — not
  // swallowed. RECOVERY_REQUIRED only ever leads to SETTLED/FAILED_FINAL/itself,
  // so quarantine can never release a result or move money on its own. The
  // transition also refreshes updated_at, so a repeatedly failing operation
  // rotates to the back of the updated_at-ordered scan instead of starving it.
  private async quarantineOperation(op:FinancialOperation,detail:string):Promise<void>{
    try{
      await this.store.recordFinancialIncident(op.operationId,"RECOVERY_FAILED",detail);
      const current=await this.store.getOperation(op.operationId)??op;
      // Only these states have a legal edge to RECOVERY_REQUIRED. transitionOperation
      // requires *every* expected state to allow the edge, so pass the single actual
      // state; anything else keeps its state (still fail-closed, retried next sweep)
      // rather than emitting a false INVALID_STATE_TRANSITION audit record.
      const quarantinable:FinancialOperationState[]=["UPSTREAM_STARTED","SETTLEMENT_PENDING","SETTLEMENT_AMBIGUOUS","SETTLED","RECOVERY_REQUIRED"];
      if(!quarantinable.includes(current.state))return;
      await this.store.transitionOperation(current.operationId,current.version,[current.state],"RECOVERY_REQUIRED",{errorCode:"RECOVERY_FAILED"});
    }catch{/* quarantine is best-effort; it must never abort the sweep either */}
  }

  // H-02: the ledger conservation check is only worth anything if something
  // actually runs it. Reconciliation is scanned like recovery, in isolation, and
  // a mismatch halts the product through the store's authoritative halt record.
  async reconcilePending(limit=50):Promise<{scanned:number;mismatched:number}>{
    const operations=await this.store.listOperationsForReconciliation(limit);let mismatched=0;
    for(const operation of operations){
      try{const result=await this.store.reconcileOperation(operation.operationId);if(!result.ok)mismatched++;}
      catch(error){try{await this.store.recordFinancialIncident(operation.operationId,"RECONCILIATION_FAILED",error instanceof Error?error.message:String(error));}catch{}}
    }
    return{scanned:operations.length,mismatched};
  }

  private killSwitchEngaged(productId: string): boolean {
    if (flagDisabled(this.env.REVENUE_SYSTEM_ENABLED ?? "true")) return true;
    if (flagDisabled(this.env[`PRODUCT_${productId}_ENABLED`])) return true;
    return false;
  }

  // H-02: the single authoritative gate for *new* financial exposure. Every call
  // re-reads the halt from the durable store rather than any cached or
  // constructor-time state, so a Worker/provider instance created before the
  // halt still blocks on its next request. Keyed by productId, so one product's
  // halt cannot block another. Nothing here clears a halt — release is an
  // explicit operator action against financial_product_halts.
  private async newExposureBlocked(productId: string, paid: boolean): Promise<string> {
    if (await this.store.isProductHalted(productId)) return "product halted by financial reconciliation incident";
    if (this.killSwitchEngaged(productId)) return "new financial exposure is disabled";
    if (paid && this.paymentProvider?.movesRealMoney && flagDisabled(this.env.REAL_PAYMENTS_ENABLED ?? "false")) return "new financial exposure is disabled";
    return "";
  }

  private emit(type: import("./types.ts").GuardEventType, productId: string, stage?: GuardStage, data?: Record<string, unknown>): void {
    this.events.emit({ type, productId, stage, data, occurredAt: Date.now() });
  }

  private reject(productId: string, stage: GuardStage, reason: string, trace: GuardStage[], paymentRequirement?:PaymentRequirementPublic): GuardOutcome {
    this.emit("request_rejected", productId, stage, { reason });
    if (stage === "budget" || stage === "quota") this.emit("budget_exceeded", productId, stage, { reason });
    return { allowed: false, stageReached: stage, reason, cacheHit: false, trace, ...(paymentRequirement?{paymentRequirement}:{}) };
  }

  private parseRequirement(op:FinancialOperation):PaymentRequirement|null{try{const value=JSON.parse(op.requirementJson) as PaymentRequirement;return value&&value.requirementId===op.requirementId?value:null;}catch{return null;}}
  private async restorePaymentProof(op:FinancialOperation):Promise<boolean>{if(op.paymentProvider==="none")return true;if(!this.paymentProvider)return false;const raw=await this.store.getPaymentProof(op.operationId);if(!raw)return false;try{return this.paymentProvider.importPaymentProof(op.paymentReference,JSON.parse(raw));}catch{return false;}}

  private async releaseSettled(op:FinancialOperation,trace:GuardStage[]):Promise<GuardOutcome>{
    const escrow=await this.store.getEscrow(op.operationId);if(!escrow||escrow.resultDigest!==op.resultDigest||escrow.expiresAt<Date.now()){await this.store.recordFinancialIncident(op.operationId,"RESULT_ESCROW_MISSING","settled operation has no valid escrow");return this.reject(op.productId,"result","settled result escrow is unavailable; recovery required",trace);}
    if(op.actualCost===null)return this.reject(op.productId,"result","settled operation has no actual cost",trace);
    await this.quota.finalize(op.reservationId,op.actualCost);
    let current=await this.store.getOperation(op.operationId);if(!current)return this.reject(op.productId,"result","operation disappeared during result release",trace);
    if(current.state==="SETTLED"){await this.store.transitionOperation(current.operationId,current.version,["SETTLED"],"RESULT_RELEASED");current=await this.store.getOperation(current.operationId)??current;}
    if(current.state!=="RESULT_RELEASED")return this.reject(op.productId,"result","result release CAS conflict; retry required",trace);
    await this.store.markEscrowReleased(op.operationId,Date.now());
    await this.store.deletePaymentProof(op.operationId);
    // H-02: the ledger identity is final for this operation the moment the
    // result is released, so check it here rather than only in the cron sweep.
    // A mismatch halts the product before the next paid request is admitted.
    // This request itself still returns — it is already paid for and settled.
    try{await this.store.reconcileOperation(op.operationId);}
    catch(error){try{await this.store.recordFinancialIncident(op.operationId,"RECONCILIATION_FAILED",error instanceof Error?error.message:String(error));}catch{}}
    this.emit("cost_recorded",op.productId,"usage_record",{cost:op.actualCost,cacheHit:false});
    if(op.paymentProvider!=="none")this.emit("revenue_recorded",op.productId,"usage_record",{amount:op.settlementAmount??0});
    this.checkpoint("before_response");
    const outbox=op.paymentProvider!=="none"?await this.store.getSettlementOutbox(op.settlementId):null;
    const requirement=this.parseRequirement(op);
    const paymentResponse=outbox&&requirement?{success:true,transaction:outbox.providerReference,network:requirement.network,payer:op.payer,amount:String(Math.ceil((op.settlementAmount??0)*1_000_000))}:undefined;
    return{allowed:true,stageReached:"usage_record",reason:"durable result replay",result:JSON.parse(escrow.payloadJson),cacheHit:true,trace:[...trace,"result","usage_record"],...(paymentResponse?{paymentResponse}:{})};
  }

  private async recoverOperation(op:FinancialOperation,trace:GuardStage[]):Promise<GuardOutcome>{
    if(op.paymentProvider!=="none"&&!['SETTLED','RESULT_RELEASED'].includes(op.state)&&!await this.restorePaymentProof(op))return this.reject(op.productId,"payment","durable payment proof is unavailable; result withheld",trace);
    if(op.state==="RESULT_RELEASED"||op.state==="SETTLED")return this.releaseSettled(op,trace);
    const escrow=await this.store.getEscrow(op.operationId);
    if(op.state==="UPSTREAM_STARTED"){
      if(escrow){const moved=await this.store.transitionOperation(op.operationId,op.version,["UPSTREAM_STARTED"],"RESULT_ESCROWED",{resultDigest:escrow.resultDigest});if(moved)op=await this.store.getOperation(op.operationId)??op;}
      else{await this.store.transitionOperation(op.operationId,op.version,["UPSTREAM_STARTED"],"RECOVERY_REQUIRED",{errorCode:"UPSTREAM_EFFECT_UNKNOWN"});await this.store.recordFinancialIncident(op.operationId,"UPSTREAM_EFFECT_UNKNOWN","upstream may have completed; replay refused");return this.reject(op.productId,"upstream","upstream state is unknown after restart; duplicate call refused",trace);}
    }
    if(op.state==="RESULT_ESCROWED")return this.settleEscrowed(op,trace,true);
    if(!["SETTLEMENT_PENDING","SETTLEMENT_AMBIGUOUS","RECOVERY_REQUIRED"].includes(op.state))return this.reject(op.productId,"payment","operation cannot be recovered from its current state",trace);
    if(!this.paymentProvider)return this.reject(op.productId,"payment","payment provider unavailable for recovery",trace);
    // H-01 root cause: an operation that reached RECOVERY_REQUIRED before
    // settleEscrowed ever ran (the UPSTREAM_EFFECT_UNKNOWN path) has no
    // settlement_outbox row. There is no settlement to look up, and the outbox
    // update below would fail on zero rows. Stay fail-closed without touching
    // the provider — no lookup, no settlement, result withheld.
    if(op.paymentProvider!=="none"&&!await this.store.getSettlementOutbox(op.settlementId)){
      if(op.errorCode!=="NO_SETTLEMENT_TRANSMITTED")await this.store.recordFinancialIncident(op.operationId,"UNKNOWN_FINANCIAL_STATE","no settlement was ever transmitted for this operation");
      await this.store.transitionOperation(op.operationId,op.version,["SETTLEMENT_PENDING","SETTLEMENT_AMBIGUOUS","RECOVERY_REQUIRED"],"RECOVERY_REQUIRED",{errorCode:"NO_SETTLEMENT_TRANSMITTED"});
      return this.reject(op.productId,"payment","no settlement obligation exists to recover; manual review required",trace);
    }
    const owner=crypto.randomUUID();if(!await this.store.claimRecovery(op.operationId,owner,Date.now(),Date.now()+30_000))return this.reject(op.productId,"payment","another recovery worker holds the lease",trace);
    try{
      op=await this.store.getOperation(op.operationId)??op;const requirement=this.parseRequirement(op);if(!requirement)return this.reject(op.productId,"payment","stored payment requirement is invalid",trace);
      const lookup=await this.paymentProvider.lookupSettlement(op.settlementId,requirement);
      if(lookup.status==="SETTLED"){
        await this.store.updateSettlementOutbox(op.settlementId,"SETTLED","",lookup.transaction);
        await this.store.transitionOperation(op.operationId,op.version,["SETTLEMENT_PENDING","SETTLEMENT_AMBIGUOUS","RECOVERY_REQUIRED"],"SETTLED",{settlementAmount:lookup.amount,payer:lookup.payer,errorCode:""});
        const settled=await this.store.getOperation(op.operationId);return settled?this.releaseSettled(settled,trace):this.reject(op.productId,"payment","settlement recovery state vanished",trace);
      }
      if(lookup.status==="FINAL_FAILURE"){
        await this.store.updateSettlementOutbox(op.settlementId,"FINAL_FAILURE",lookup.reason);
        await this.store.transitionOperation(op.operationId,op.version,["SETTLEMENT_PENDING","SETTLEMENT_AMBIGUOUS","RECOVERY_REQUIRED"],"FAILED_FINAL",{errorCode:"SETTLEMENT_FINAL_FAILURE"});
        if(op.actualCost!==null)await this.quota.finalize(op.reservationId,op.actualCost);
        return this.reject(op.productId,"payment","settlement was authoritatively rejected; result withheld",trace);
      }
      await this.store.updateSettlementOutbox(op.settlementId,"AMBIGUOUS","STATUS_UNKNOWN");
      await this.store.transitionOperation(op.operationId,op.version,["SETTLEMENT_PENDING","SETTLEMENT_AMBIGUOUS","RECOVERY_REQUIRED"],"RECOVERY_REQUIRED",{errorCode:"UNKNOWN_FINANCIAL_STATE"});
      await this.store.recordFinancialIncident(op.operationId,"UNKNOWN_FINANCIAL_STATE","provider settlement status lookup unavailable");
      return this.reject(op.productId,"payment","unknown financial state; no retry, result withheld",trace);
    }finally{await this.store.releaseRecovery(op.operationId,owner);}
  }

  private async settleEscrowed(op:FinancialOperation,trace:GuardStage[],recovery:boolean):Promise<GuardOutcome>{
    const escrow=await this.store.getEscrow(op.operationId);if(!escrow)return this.reject(op.productId,"result","durable result escrow missing",trace);
    if(op.actualCost===null)return this.reject(op.productId,"result","actual cost missing",trace);
    const actualCost=op.actualCost;
    if(op.paymentProvider==="none"){
      const moved=await this.store.transitionOperation(op.operationId,op.version,["RESULT_ESCROWED"],"SETTLED",{settlementAmount:0});
      const settled=moved?await this.store.getOperation(op.operationId):null;return settled?this.releaseSettled(settled,trace):this.reject(op.productId,"result","free result release CAS conflict",trace);
    }
    if(!this.paymentProvider)return this.reject(op.productId,"payment","payment provider unavailable",trace);
    if(!await this.restorePaymentProof(op))return this.reject(op.productId,"payment","durable payment proof is unavailable; result withheld",trace);
    const requirement=this.parseRequirement(op);if(!requirement)return this.reject(op.productId,"payment","stored payment requirement is invalid",trace);
    if(recovery){const auth=await this.paymentProvider.authorizePayment(op.paymentReference,op.authorizedAmount,requirement);if(!auth.authorized)return this.reject(op.productId,"payment","payment proof required to resume pre-settlement obligation",trace);}
    const now=Date.now();const outbox:SettlementOutboxRow={settlementId:op.settlementId,operationId:op.operationId,paymentProvider:op.paymentProvider,amount:actualCost,status:"PENDING",attemptCount:0,lastAttemptAt:null,providerReference:"",lastErrorCode:"",createdAt:now,updatedAt:now};
    await this.store.createSettlementOutbox(outbox);
    if(!await this.store.transitionOperation(op.operationId,op.version,["RESULT_ESCROWED"],"SETTLEMENT_PENDING"))return this.recoverOperation(await this.store.getOperation(op.operationId)??op,trace);
    op=await this.store.getOperation(op.operationId)??op;this.checkpoint("before_settlement");
    const settled=await this.paymentProvider.settlePayment(op.paymentReference,actualCost,op.settlementId,requirement,recovery);
    this.checkpoint("after_settlement_transmission");
    if(settled.disposition==="AMBIGUOUS"){
      await this.store.updateSettlementOutbox(op.settlementId,"AMBIGUOUS","AMBIGUOUS_TRANSPORT");
      await this.store.transitionOperation(op.operationId,op.version,["SETTLEMENT_PENDING"],"SETTLEMENT_AMBIGUOUS",{errorCode:"UNKNOWN_FINANCIAL_STATE"});
      await this.store.recordFinancialIncident(op.operationId,"AMBIGUOUS_SETTLEMENT","settlement request outcome is unknown");
      return this.reject(op.productId,"payment","settlement ambiguous; result withheld pending authoritative recovery",trace);
    }
    if(!settled.settled){await this.store.updateSettlementOutbox(op.settlementId,"FINAL_FAILURE",settled.reason);await this.store.transitionOperation(op.operationId,op.version,["SETTLEMENT_PENDING"],"FAILED_FINAL",{errorCode:"SETTLEMENT_FINAL_FAILURE"});await this.quota.finalize(op.reservationId,actualCost);return this.reject(op.productId,"payment","settlement failed; paid result withheld",trace);}
    this.checkpoint("after_settlement_success_before_state");
    await this.store.updateSettlementOutbox(op.settlementId,"SETTLED","",settled.transaction);
    if(!await this.store.transitionOperation(op.operationId,op.version,["SETTLEMENT_PENDING"],"SETTLED",{settlementAmount:settled.amount,payer:settled.payer,errorCode:""}))return this.reject(op.productId,"payment","settlement recorded but operation CAS failed; recovery required",trace);
    this.checkpoint("after_settled_state");const complete=await this.store.getOperation(op.operationId);return complete?this.releaseSettled(complete,trace):this.reject(op.productId,"payment","settled operation missing",trace);
  }

  async processRequest(ctx:RequestContext):Promise<GuardOutcome>{
    this.emit("request_received",ctx.productId,undefined,{identityKind:ctx.identityKind});const trace:GuardStage[]=["kill_switch"];
    // H-02: the halt is enforced by newExposureBlocked() below, re-read from the
    // authoritative store at every gate. It is deliberately NOT checked here, so
    // an existing obligation can still be recovered/replayed while the product is
    // halted (no new exposure) — see the recoverOperation dispatch further down.
    trace.push("auth");if(!ctx.authenticated)return this.reject(ctx.productId,"auth","not authenticated",trace);
    trace.push("estimate_cost");if(!Number.isFinite(ctx.estimatedCost)||ctx.estimatedCost<0)return this.reject(ctx.productId,"estimate_cost","maximum upstream cost is unknown or invalid",trace);
    if(ctx.pricePerCall===0&&ctx.estimatedCost>0)return this.reject(ctx.productId,"estimate_cost","zero-price request cannot incur paid upstream cost",trace);
    trace.push("margin");if(ctx.pricePerCall>0&&!checkPrice(ctx.pricePerCall,ctx.estimatedCost,this.guard).passes)return this.reject(ctx.productId,"margin","price does not cover worst-case cost",trace);
    if(ctx.pricePerCall===0&&ctx.estimatedCost===0){trace.push("cache");try{const cached=await this.cache.get(ctx.productId,ctx.requestPayload);if(cached.hit){this.emit("cache_hit",ctx.productId,"cache");this.emit("cost_recorded",ctx.productId,"usage_record",{cost:0,cacheHit:true});return{allowed:true,stageReached:"result",reason:"cache hit",result:cached.value,cacheHit:true,trace:[...trace,"result"]};}}catch{} }
    const requestHash=await digestText(JSON.stringify({productId:ctx.productId,payload:ctx.requestPayload}));
    const requestId=ctx.requestId&&/^[A-Za-z0-9._:-]{16,160}$/.test(ctx.requestId)?ctx.requestId:requestHash;
    let requirement:PaymentRequirement|undefined;let publicRequirement:PaymentRequirementPublic|undefined;const ceiling=Math.max(ctx.estimatedCost,ctx.pricePerCall);
    if(ctx.pricePerCall>0){
      if(!this.paymentProvider)return this.reject(ctx.productId,"payment","payment provider required",trace);
      const terms=this.paymentProvider.terms();const base={requirementId:`${requestId}:requirement`,productId:ctx.productId,requestHash,amount:String(Math.ceil(ceiling*1_000_000)),asset:terms.asset,network:terms.network,payTo:terms.payTo,scheme:"upto" as const,expiresAt:new Date(Date.now()+300_000).toISOString(),nonce:requestId,provider:"x402" as const};requirement={...base,digest:await digestText(JSON.stringify(base))};publicRequirement={scheme:"upto",network:terms.network,amount:requirement.amount,asset:terms.asset,payTo:terms.payTo,maxTimeoutSeconds:300,extra:{}};
    }
    let op=await this.store.getOperation(requestId);
    if(op&&op.paymentProvider!=="none"&&!['SETTLED','RESULT_RELEASED'].includes(op.state)&&!await this.restorePaymentProof(op))return this.reject(ctx.productId,"payment","durable payment proof is unavailable; result withheld",trace,publicRequirement);
    if(op){if(op.requestHash!==requestHash||op.productId!==ctx.productId){await this.store.recordFinancialIncident(op.operationId,"IDEMPOTENCY_KEY_REUSE","request identity mismatch");return this.reject(ctx.productId,"payment","idempotency key is bound to another request",trace);}if(["RESULT_RELEASED","SETTLED","UPSTREAM_STARTED","RESULT_ESCROWED","SETTLEMENT_PENDING","SETTLEMENT_AMBIGUOUS","RECOVERY_REQUIRED"].includes(op.state)){if(op.paymentProvider==="none"&&op.state==="RESULT_RELEASED")this.emit("cache_hit",ctx.productId,"cache");return this.recoverOperation(op,trace);}if(op.state==="FAILED_FINAL")return this.reject(ctx.productId,"payment","operation is in a final failed state",trace);}
    if(!op&&requirement&&!ctx.paymentReference)return this.reject(ctx.productId,"payment","payment proof required",trace,publicRequirement);
    const blockedBefore=await this.newExposureBlocked(ctx.productId,ctx.pricePerCall>0);
    if(blockedBefore)return this.reject(ctx.productId,"kill_switch",blockedBefore,trace);
    trace.push("rate_limit");const rate=await this.rateLimiter.check(ctx.productId,ctx.identityKind,ctx.identityValue);if(!rate.allowed)return this.reject(ctx.productId,"rate_limit","rate limit exceeded",trace);
    if(!op){const now=Date.now();const created:FinancialOperation={operationId:requestId,requestId,requirementId:requirement?.requirementId??`${requestId}:free`,productId:ctx.productId,requestHash,artifactHash:ctx.artifactHash??"unbound",paymentProvider:requirement?"x402":"none",paymentReference:ctx.paymentReference??"",requirementJson:requirement?JSON.stringify(requirement):"",payer:"",reservationId:requestId,upstreamOperationId:`${requestId}:upstream`,settlementId:`${requestId}:settlement`,state:"CREATED",authorizedAmount:ceiling,reservedAmount:ctx.estimatedCost,actualCost:null,settlementAmount:null,resultDigest:"",errorCode:"",version:0,recoveryOwner:"",recoveryLeaseUntil:0,createdAt:now,updatedAt:now};await this.store.createOperation(created);op=await this.store.getOperation(requestId);if(!op)return this.reject(ctx.productId,"budget","could not create durable operation",trace);if(requirement&&this.paymentProvider&&ctx.paymentReference){const proof=this.paymentProvider.exportPaymentProof(ctx.paymentReference);let serialized="";try{serialized=JSON.stringify(proof);}catch{}const saved=proof!==null&&serialized.length>0&&await this.store.savePaymentProof(op.operationId,serialized,Date.now()+86_400_000);if(!saved&&!await this.store.getPaymentProof(op.operationId)){await this.store.transitionOperation(op.operationId,op.version,["CREATED"],"FAILED_FINAL",{errorCode:"PAYMENT_PROOF_PERSIST_FAILED"});return this.reject(ctx.productId,"payment","payment proof could not be persisted",trace,publicRequirement);}}}
    trace.push("budget");if(op.state==="CREATED"){const reserved=await this.quota.reserve(op.reservationId,ctx.productId,ctx.estimatedCost,ctx.identityKind,ctx.identityValue);if(!reserved.allowed)return this.reject(ctx.productId,"budget",reserved.reason,trace);if(!await this.store.transitionOperation(op.operationId,op.version,["CREATED"],"COST_RESERVED"))return this.reject(ctx.productId,"budget","reservation state CAS conflict",trace);this.checkpoint("after_reservation");op=await this.store.getOperation(op.operationId)??op;}
    trace.push("payment");if(op.state==="COST_RESERVED"){
      if(requirement&&this.paymentProvider&&(op.paymentReference||ctx.paymentReference)){const reference=op.paymentReference||ctx.paymentReference||"";const auth=await this.paymentProvider.authorizePayment(reference,ceiling,requirement);if(!auth.authorized||!Number.isFinite(auth.maxAmount)||auth.maxAmount<ceiling){await this.quota.release(op.reservationId);await this.store.transitionOperation(op.operationId,op.version,["COST_RESERVED"],"FAILED_FINAL",{errorCode:"UNDER_AUTHORIZATION"});return this.reject(ctx.productId,"payment","payment did not cover immutable server requirement",trace,publicRequirement);}if(!await this.store.transitionOperation(op.operationId,op.version,["COST_RESERVED"],"PAYMENT_AUTHORIZED",{payer:auth.payer,paymentReference:reference,requirementJson:JSON.stringify(requirement),authorizedAmount:ceiling}))return this.reject(ctx.productId,"payment","authorization state CAS conflict",trace);this.emit("payment_verified",ctx.productId,"payment",{reference,requirementId:requirement.requirementId});}
      else if(!requirement){if(!await this.store.transitionOperation(op.operationId,op.version,["COST_RESERVED"],"PAYMENT_AUTHORIZED"))return this.reject(ctx.productId,"payment","free operation state CAS conflict",trace);}
      this.checkpoint("after_payment_authorized");op=await this.store.getOperation(op.operationId)??op;
    }
    if(op.state!=="PAYMENT_AUTHORIZED")return this.recoverOperation(op,trace);
    if(requirement&&this.paymentProvider?.movesRealMoney){const auth=await this.paymentProvider.authorizePayment(op.paymentReference,op.authorizedAmount,requirement);if(!auth.authorized)return this.reject(ctx.productId,"payment","durable payment proof re-verification failed",trace,publicRequirement);}
    const blockedNow=await this.newExposureBlocked(ctx.productId,ctx.pricePerCall>0);
    if(blockedNow){await this.quota.release(op.reservationId);await this.store.transitionOperation(op.operationId,op.version,["PAYMENT_AUTHORIZED"],"FAILED_FINAL",{errorCode:"KILL_BEFORE_UPSTREAM"});return this.reject(ctx.productId,"kill_switch","safety state revoked before upstream",trace);}
    trace.push("upstream");const circuit=await this.circuit.check(ctx.upstreamName);if(!circuit.allowed){this.emit("circuit_opened",ctx.productId,"upstream",{upstream:ctx.upstreamName});await this.quota.release(op.reservationId);return this.reject(ctx.productId,"upstream","circuit open",trace);}
    if(!await this.store.transitionOperation(op.operationId,op.version,["PAYMENT_AUTHORIZED"],"UPSTREAM_STARTED"))return this.reject(ctx.productId,"upstream","another worker owns the upstream operation",trace);op=await this.store.getOperation(op.operationId)??op;this.checkpoint("before_upstream");
    let result:unknown;try{this.emit("upstream_called",ctx.productId,"upstream");result=await ctx.upstream(op.upstreamOperationId);await this.circuit.recordSuccess(ctx.upstreamName);}catch(exc){await this.circuit.recordFailure(ctx.upstreamName);await this.quota.finalize(op.reservationId,ctx.estimatedCost);await this.store.transitionOperation(op.operationId,op.version,["UPSTREAM_STARTED"],"FAILED_FINAL",{actualCost:ctx.estimatedCost,errorCode:"UPSTREAM_FAILED"});return this.reject(ctx.productId,"upstream",`upstream call failed: ${(exc as Error).message}`,trace);}
    this.emit("result_returned",ctx.productId,"result");this.checkpoint("after_upstream");trace.push("result");const actual=ctx.actualCost?.(result)??Number.NaN;if(!Number.isFinite(actual)||actual<0||actual>ctx.estimatedCost){await this.quota.finalize(op.reservationId,ctx.estimatedCost);await this.store.transitionOperation(op.operationId,op.version,["UPSTREAM_STARTED"],"FAILED_FINAL",{actualCost:ctx.estimatedCost,errorCode:"INVALID_ACTUAL_COST"});return this.reject(ctx.productId,"result","actual cost is invalid or above authorized ceiling",trace);}
    let payloadJson:string;try{payloadJson=safeResultJson(result,ctx.outputSchema);}catch(exc){await this.quota.finalize(op.reservationId,actual);await this.store.transitionOperation(op.operationId,op.version,["UPSTREAM_STARTED"],"FAILED_FINAL",{actualCost:actual,errorCode:"UNSAFE_RESULT"});return this.reject(ctx.productId,"result",(exc as Error).message,trace);}
    const resultDigest=await digestText(payloadJson);const escrow:ResultEscrowRow={operationId:op.operationId,resultDigest,payloadJson,payloadSize:new TextEncoder().encode(payloadJson).length,createdAt:Date.now(),expiresAt:Date.now()+86_400_000,releasedAt:null};await this.store.saveEscrow(escrow);if(!await this.store.transitionOperation(op.operationId,op.version,["UPSTREAM_STARTED"],"RESULT_ESCROWED",{actualCost:actual,resultDigest}))return this.reject(ctx.productId,"result","escrow state CAS conflict; recovery required",trace);this.checkpoint("after_result_escrow");op=await this.store.getOperation(op.operationId)??op;return this.settleEscrowed(op,trace,false);
  }
}
