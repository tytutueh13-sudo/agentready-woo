import test from "node:test";
import assert from "node:assert/strict";
import { AppStore, type ReleaseApiTokenRow } from "../src/core/appStore.ts";
import { hashToken } from "../src/core/auth.ts";
import { authenticateReleaseToken, createReleaseToken, parseTokenCreate, rotateReleaseToken } from "../src/releaseGate/apiTokens.ts";
import { sqliteD1 } from "./helpers/sqlite.ts";
import { previousEvidenceKeyAllowed } from "../src/app.ts";

test("release API tokens are digest-only, account/store scoped, expired and revoked fail closed",async()=>{
  const {db,raw}=sqliteD1();const app=new AppStore(db);const now=Date.now();
  await app.createUser("account_a","a@example.test","hash");await app.createUser("account_b","b@example.test","hash");
  for(const [id,user] of [["store_aaaa","account_a"],["store_bbbb","account_b"]] as const)await app.createStore({id,userId:user,name:id,storeUrl:"https://shop.example",wooKeyEnc:"k",wooSecretEnc:"s",plan:"free",status:"active",createdAt:now,updatedAt:now});
  const created=await createReleaseToken(app,"account_a",parseTokenCreate({name:"release",scopes:["release:start","release:read","release:claim"],store_id:"store_aaaa"}));
  assert.equal((await authenticateReleaseToken(app,`Bearer ${created.token}`,"release:start","store_aaaa"))?.accountId,"account_a");
  assert.equal(await authenticateReleaseToken(app,`Bearer ${created.token}`,"release:start","store_bbbb"),null,"store scope cannot cross tenant");
  assert.equal((raw.prepare("SELECT COUNT(*) n FROM release_gate_api_tokens WHERE token_digest=?").get(created.row.tokenDigest) as {n:number}).n,1);
  assert.equal((raw.prepare("SELECT COUNT(*) n FROM release_gate_api_tokens WHERE token_digest=?").get(created.token) as {n:number}).n,0,"raw API token is never persisted");
  const readOnly=await createReleaseToken(app,"account_a",parseTokenCreate({name:"read",scopes:["release:read"]}));assert.equal(await authenticateReleaseToken(app,`Bearer ${readOnly.token}`,"release:start"),null,"wrong scope fails closed");
  assert.equal(await app.revokeReleaseApiToken(created.row.id,"account_a"),true);assert.equal(await authenticateReleaseToken(app,`Bearer ${created.token}`,"release:read"),null,"revoked token fails closed");
  const expiredRaw="arw_rg_expired_token_012345678901234567890123456789";const expired:ReleaseApiTokenRow={id:"token_expired",accountId:"account_a",tokenDigest:await hashToken(expiredRaw),name:"expired",scopes:["release:read"],storeId:null,createdAt:now,expiresAt:now-1,revokedAt:null};assert.equal(await app.createReleaseApiToken(expired),true);assert.equal(await authenticateReleaseToken(app,`Bearer ${expiredRaw}`,"release:read"),null,"expired token fails closed");
});

test("previous evidence key requires a valid finite grace deadline",()=>{
  const now=1_800_000_000_000;assert.equal(previousEvidenceKeyAllowed(undefined,now),false);assert.equal(previousEvidenceKeyAllowed("nonsense",now),false);assert.equal(previousEvidenceKeyAllowed(new Date(now).toISOString(),now),false,"exact expiry is rejected");assert.equal(previousEvidenceKeyAllowed(new Date(now+1).toISOString(),now),true);assert.equal(previousEvidenceKeyAllowed(new Date(now-1).toISOString(),now),false);
});

test("rotation revoke failure leaves no second active credential",async()=>{
  const {db}=sqliteD1();const app=new AppStore(db);await app.createUser("account_a","a@example.test","hash");const original=await createReleaseToken(app,"account_a",parseTokenCreate({name:"rotate",scopes:["release:read"]}));const realRevoke=app.revokeReleaseApiToken.bind(app);(app as unknown as {revokeReleaseApiToken:(id:string,account:string)=>Promise<boolean>}).revokeReleaseApiToken=async(id,account)=>id===original.row.id?false:realRevoke(id,account);
  await assert.rejects(()=>rotateReleaseToken(app,"account_a",original.row),/INFRA_PERSISTENCE_FAILED/);const rows=await app.listReleaseApiTokens("account_a");assert.equal(rows.filter(r=>r.revokedAt===null).length,1,"failed rotation must not leave old and new active");
});
