// Spec-aligned x402 v2 adapter. Production uses this class; the mock remains
// available only to local contract tests.
import type { PaymentStatus, PaymentVerification } from "./types.ts";

export interface PaymentRequirement {
  requirementId:string; productId:string; requestHash:string; amount:string;
  asset:string; network:string; payTo:string; scheme:"upto"; expiresAt:string;
  nonce:string; provider:"x402"; digest:string;
}
export interface Authorization { authorized:boolean; payer:string; maxAmount:number; reason:string; }
export type SettlementDisposition="SETTLED"|"FINAL_FAILURE"|"AMBIGUOUS";
export interface Settlement { settled:boolean; payer:string; amount:number; transaction:string; reason:string; disposition:SettlementDisposition; }
export interface SettlementLookup { status:"SETTLED"|"FINAL_FAILURE"|"UNKNOWN"; payer:string; amount:number; transaction:string; reason:string; }
export interface PaymentProvider {
  readonly movesRealMoney:boolean;
  terms(): { asset:string; network:string; payTo:string; scheme:"upto" };
  authorizePayment(reference:string, maximum:number, requirement:PaymentRequirement):Promise<Authorization>;
  settlePayment(reference:string, actual:number, settlementId:string, requirement:PaymentRequirement, recovery?:boolean):Promise<Settlement>;
  lookupSettlement(settlementId:string, requirement:PaymentRequirement):Promise<SettlementLookup>;
  verifyPayment(reference:string):Promise<PaymentVerification>;
  getPaymentAmount(reference:string):Promise<number>;
  getPayer(reference:string):Promise<string>;
  recordTransaction(productId:string, verification:PaymentVerification):Promise<void>;
  exportPaymentProof(reference:string):unknown|null;
  importPaymentProof(reference:string,payload:unknown):boolean;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly movesRealMoney=false;
  private references=new Map<string,PaymentVerification>(); public transactions:Array<[string,PaymentVerification]>= [];
  register(reference:string,status:PaymentStatus,amount=0,payer=""):void{this.references.set(reference,{status,amount,payer,reference});}
  private lookup(reference:string):PaymentVerification{return this.references.get(reference)??{status:"invalid",amount:0,payer:"",reference};}
  terms(){return {asset:"USD",network:"local",payTo:"local-test-merchant",scheme:"upto" as const};}
  async authorizePayment(reference:string,maximum:number):Promise<Authorization>{const v=this.lookup(reference);return{authorized:v.status==="paid"&&v.amount>=maximum,payer:v.payer,maxAmount:v.amount,reason:v.status==="paid"?"":"not paid"};}
  async settlePayment(reference:string,actual:number):Promise<Settlement>{const v=this.lookup(reference),ok=v.status==="paid"&&v.amount>=actual;return{settled:ok,payer:v.payer,amount:ok?actual:0,transaction:ok?reference:"",reason:ok?"":"not paid",disposition:ok?"SETTLED":"FINAL_FAILURE"};}
  async lookupSettlement(settlementId:string):Promise<SettlementLookup>{const v=this.lookup(settlementId);return v.status==="paid"?{status:"SETTLED",payer:v.payer,amount:v.amount,transaction:settlementId,reason:""}:{status:"UNKNOWN",payer:"",amount:0,transaction:"",reason:"mock has no durable settlement"};}
  async verifyPayment(reference:string){return this.lookup(reference);} async getPaymentAmount(reference:string){return this.lookup(reference).amount;} async getPayer(reference:string){return this.lookup(reference).payer;}
  async recordTransaction(productId:string,v:PaymentVerification){this.transactions.push([productId,v]);}
  exportPaymentProof(reference:string):unknown|null{return this.references.has(reference)?{reference}:null;}
  importPaymentProof(_reference:string,_payload:unknown):boolean{return true;}
}

interface X402Env { X402_FACILITATOR_URL?:string; X402_PAY_TO?:string; X402_ASSET?:string; X402_NETWORK?:string; REAL_PAYMENTS_ENABLED?:string; }
export class X402PaymentProvider implements PaymentProvider {
  readonly movesRealMoney=true;
  private pending=new Map<string,{paymentPayload:unknown}>();
  private verified=new Set<string>();
  private env:X402Env; constructor(env:X402Env){this.env=env;}
  terms(){return{asset:this.env.X402_ASSET??"",network:this.env.X402_NETWORK??"eip155:84532",payTo:this.env.X402_PAY_TO??"",scheme:"upto" as const};}
  registerPayment(reference:string,paymentPayload:unknown):boolean{
    if(this.pending.has(reference))return false;
    this.pending.set(reference,{paymentPayload:structuredClone(paymentPayload)});return true;
  }
  exportPaymentProof(reference:string):unknown|null{const row=this.pending.get(reference);return row?structuredClone(row.paymentPayload):null;}
  importPaymentProof(reference:string,payload:unknown):boolean{if(this.pending.has(reference))return true;if(!payload||typeof payload!=="object"||Array.isArray(payload))return false;this.pending.set(reference,{paymentPayload:structuredClone(payload)});return true;}
  private enabled():boolean{return(this.env.REAL_PAYMENTS_ENABLED??"false").trim().toLowerCase()==="true";}
  private async post(path:string,body:unknown,idempotencyKey=""):Promise<Record<string,unknown>>{
    const base=(this.env.X402_FACILITATOR_URL??"").replace(/\/$/,""); if(!base)throw new Error("facilitator not configured");
    const response=await fetch(base+path,{method:"POST",redirect:"error",headers:{"content-type":"application/json",...(idempotencyKey?{"Idempotency-Key":idempotencyKey}:{})},body:JSON.stringify(body)});
    if(!response.ok)throw new Error(`facilitator HTTP ${response.status}`); const value:unknown=await response.json();
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("invalid facilitator schema"); return value as Record<string,unknown>;
  }
  async authorizePayment(reference:string,maximum:number,r:PaymentRequirement):Promise<Authorization>{
    const p=this.pending.get(reference),t=this.terms(); if(!p)return{authorized:false,payer:"",maxAmount:0,reason:"missing payment proof"};
    const q={scheme:r.scheme,network:r.network,amount:r.amount,asset:r.asset,payTo:r.payTo,maxTimeoutSeconds:300,extra:{}};
    const payload=p.paymentPayload as Record<string,unknown>;const accepted=payload.accepted as Record<string,unknown>|undefined;
    const match=r.provider==="x402"&&r.scheme==="upto"&&r.asset===t.asset&&r.network===t.network&&r.payTo===t.payTo&&!!accepted&&accepted.scheme===q.scheme&&accepted.network===q.network&&accepted.amount===q.amount&&accepted.asset===q.asset&&accepted.payTo===q.payTo;
    if(!match)return{authorized:false,payer:"",maxAmount:0,reason:"server requirement binding mismatch"};
    try{const out=await this.post("/verify",{x402Version:2,paymentPayload:p.paymentPayload,paymentRequirements:q});if(typeof out.isValid!=="boolean")return{authorized:false,payer:"",maxAmount:0,reason:"invalid verify schema"};if(out.isValid)this.verified.add(reference);return{authorized:out.isValid,payer:typeof out.payer==="string"?out.payer:"",maxAmount:maximum,reason:out.isValid?"":"verify rejected"};}catch{return{authorized:false,payer:"",maxAmount:0,reason:"verify unavailable"};}
  }
  async settlePayment(reference:string,actual:number,id:string,r:PaymentRequirement,recovery=false):Promise<Settlement>{
    if(!recovery&&!this.enabled())return{settled:false,payer:"",amount:0,transaction:"",reason:"payments disabled",disposition:"FINAL_FAILURE"};
    const p=this.pending.get(reference);if(!p||!this.verified.has(reference))return{settled:false,payer:"",amount:0,transaction:"",reason:"not verified",disposition:"FINAL_FAILURE"};
    const ceiling=Number(r.amount)/1_000_000;if(!Number.isFinite(actual)||actual<0||actual>ceiling)return{settled:false,payer:"",amount:0,transaction:"",reason:"actual exceeds ceiling",disposition:"FINAL_FAILURE"};
    const q={scheme:r.scheme,network:r.network,amount:String(Math.ceil(actual*1_000_000)),asset:r.asset,payTo:r.payTo,maxTimeoutSeconds:300,extra:{}};
    try{const out=await this.post("/settle",{x402Version:2,paymentPayload:p.paymentPayload,paymentRequirements:q},id);if(typeof out.success!=="boolean")throw new Error("invalid settle schema");return{settled:out.success,payer:typeof out.payer==="string"?out.payer:"",amount:out.success?actual:0,transaction:typeof out.transaction==="string"?out.transaction:"",reason:out.success?"":"settle rejected",disposition:out.success?"SETTLED":"FINAL_FAILURE"};}catch{return{settled:false,payer:"",amount:0,transaction:"",reason:"ambiguous settlement; automatic replay disabled",disposition:"AMBIGUOUS"};}
  }
  async lookupSettlement(_id:string,_r:PaymentRequirement):Promise<SettlementLookup>{return{status:"UNKNOWN",payer:"",amount:0,transaction:"",reason:"x402 v2 defines no standard settlement lookup; product remains blocked until facilitator-specific interoperability is verified"};}
  async verifyPayment(reference:string){return{status:(this.verified.has(reference)?"paid":"invalid") as PaymentStatus,amount:0,payer:"",reference};}
  async getPaymentAmount(reference:string){return(await this.verifyPayment(reference)).amount;} async getPayer(){return"";} async recordTransaction():Promise<void>{}
}
