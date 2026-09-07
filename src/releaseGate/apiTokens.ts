import { AppStore, type ReleaseApiTokenRow, type ReleaseTokenScope } from "../core/appStore.ts";
import { hashToken, newSessionToken } from "../core/auth.ts";

export const RELEASE_TOKEN_SCOPES = ["release:start", "release:read", "release:claim"] as const;
const scopeSet = new Set<string>(RELEASE_TOKEN_SCOPES);
export interface ReleaseTokenPrincipal { accountId:string; tokenId:string; storeId:string|null; scopes:ReleaseTokenScope[]; }

function equal(a:string,b:string):boolean { let mismatch=a.length===b.length?0:1; for(let i=0;i<Math.max(a.length,b.length);i++) mismatch|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0); return mismatch===0; }
function safeName(value:unknown):string { if(typeof value!=="string"||! /^[A-Za-z0-9 _.-]{1,80}$/.test(value)) throw new Error("INVALID_TOKEN_NAME"); return value; }
export function parseTokenCreate(value:unknown):{name:string;scopes:ReleaseTokenScope[];store_id:string|null;expires_at:number|null}{
  if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("INVALID_BODY"); const v=value as Record<string,unknown>;
  if(Object.keys(v).some(k=>k!=="name"&&k!=="scopes"&&k!=="store_id"&&k!=="expires_at"))throw new Error("UNKNOWN_PROPERTY");
  if(!Array.isArray(v.scopes)||v.scopes.length<1||v.scopes.length>RELEASE_TOKEN_SCOPES.length||v.scopes.some(s=>typeof s!=="string"||!scopeSet.has(s))||new Set(v.scopes).size!==v.scopes.length)throw new Error("INVALID_SCOPES");
  const storeId=v.store_id===undefined?null:v.store_id; if(storeId!==null&&(typeof storeId!=="string"||!/^[A-Za-z0-9_-]{8,100}$/.test(storeId)))throw new Error("INVALID_STORE_ID");
  const expires=v.expires_at===undefined?null:v.expires_at; if(expires!==null&&(typeof expires!=="string"||!Number.isFinite(Date.parse(expires))||Date.parse(expires)<=Date.now()||Date.parse(expires)>Date.now()+366*86400000))throw new Error("INVALID_EXPIRY");
  return {name:safeName(v.name),scopes:v.scopes as ReleaseTokenScope[],store_id:storeId,expires_at:expires===null?null:Date.parse(expires)};
}
export async function createReleaseToken(app:AppStore,accountId:string,input:ReturnType<typeof parseTokenCreate>):Promise<{token:string;row:ReleaseApiTokenRow}>{
  if(input.store_id){const store=await app.getStoreForUser(input.store_id,accountId);if(!store)throw new Error("STORE_NOT_FOUND");}
  const token=`arw_rg_${newSessionToken()}`; const row:ReleaseApiTokenRow={id:crypto.randomUUID(),accountId,tokenDigest:await hashToken(token),name:input.name,scopes:input.scopes,storeId:input.store_id,createdAt:Date.now(),expiresAt:input.expires_at,revokedAt:null};
  if(!await app.createReleaseApiToken(row))throw new Error("INFRA_PERSISTENCE_FAILED"); return {token,row};
}
/** A replacement remains blocked until the old credential is durably revoked.
 * If either transition fails, the replacement is revoked too, so callers
 * never receive a success response with two live credentials. */
export async function rotateReleaseToken(app:AppStore,accountId:string,prior:ReleaseApiTokenRow):Promise<{token:string;row:ReleaseApiTokenRow}>{
  const created=await createReleaseToken(app,accountId,{name:prior.name,scopes:prior.scopes,store_id:prior.storeId,expires_at:prior.expiresAt});
  if(!await app.blockReleaseApiToken(created.row.id,"rotation-pending")){await app.revokeReleaseApiToken(created.row.id,accountId);throw new Error("INFRA_PERSISTENCE_FAILED");}
  if(!await app.revokeReleaseApiToken(prior.id,accountId)){await app.revokeReleaseApiToken(created.row.id,accountId);throw new Error("INFRA_PERSISTENCE_FAILED");}
  if(!await app.unblockReleaseApiToken(created.row.id)){await app.revokeReleaseApiToken(created.row.id,accountId);throw new Error("INFRA_PERSISTENCE_FAILED");}
  return created;
}
export function publicToken(row:ReleaseApiTokenRow):Omit<ReleaseApiTokenRow,"tokenDigest"> { const {tokenDigest,...safe}=row; return safe; }
export async function authenticateReleaseToken(app:AppStore,authorization:string|undefined,scope:ReleaseTokenScope,storeId?:string):Promise<ReleaseTokenPrincipal|null>{
  const raw=authorization?.startsWith("Bearer ")?authorization.slice(7):""; if(!/^arw_rg_[A-Za-z0-9_-]{30,100}$/.test(raw))return null;
  const digest=await hashToken(raw); const row=await app.getReleaseApiToken(digest); if(!row||!equal(digest,row.tokenDigest)||!row.scopes.includes(scope)||(storeId!==undefined&&row.storeId!==null&&row.storeId!==storeId))return null;
  return {accountId:row.accountId,tokenId:row.id,storeId:row.storeId,scopes:row.scopes};
}
