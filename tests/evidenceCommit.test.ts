import test from "node:test";
import assert from "node:assert/strict";
import { AppStore } from "../src/core/appStore.ts";
import { sqliteD1 } from "./helpers/sqlite.ts";

test("evidence commit crash checkpoints recover one committed active generation without orphans",async()=>{
  const {db,raw}=sqliteD1();const app=new AppStore(db);const expires=Date.now()+60000;const packet='{"safe":true}';
  // before nonce claim: no durable row; a retry creates exactly one commit.
  assert.equal(await app.recordPluginEvidence("receipt_before","store_aaaa","account_a","nonce_before","a".repeat(64),packet,expires,100),"stored");
  // after nonce claim / after generation / before commit: the durable pending
  // record is completed by an idempotent retry, not used while pending.
  await app.ensureSchema();await db.prepare("INSERT INTO release_gate_evidence_commits(receipt_id,store_id,account_id,nonce,digest,safe_packet_json,expires_at,state,created_at) VALUES(?,?,?,?,?,?,?,'PENDING',?)").bind("receipt_pending","store_pend","account_a","nonce_pending","b".repeat(64),packet,expires,Date.now()).run();
  assert.equal(await app.getActivePluginEvidence("store_pend","account_a"),null,"unpointed pending evidence is inert");assert.equal(await app.recordPluginEvidence("retry_pending","store_pend","account_a","nonce_pending","b".repeat(64),packet,expires,200),"replay");assert.equal((raw.prepare("SELECT generated_at FROM release_gate_evidence_order WHERE receipt_id='receipt_pending'").get() as {generated_at:number}).generated_at,200,"a retry restores ordering after a crash between PENDING and order persistence");assert.equal((await app.getActivePluginEvidence("store_pend","account_a"))?.receiptId,"receipt_pending");
  // after commit / before response: retry repairs a missing pointer, while a
  // different digest for the same nonce is a conflict rather than overwrite.
  await db.prepare("INSERT INTO release_gate_evidence_commits(receipt_id,store_id,account_id,nonce,digest,safe_packet_json,expires_at,state,created_at) VALUES(?,?,?,?,?,?,?,'COMMITTED',?)").bind("receipt_committed","store_comm","account_a","nonce_committed","c".repeat(64),packet,expires,Date.now()).run();
  await db.prepare("INSERT INTO release_gate_evidence_order(receipt_id,generated_at) VALUES(?,?)").bind("receipt_committed",300).run();assert.equal(await app.recordPluginEvidence("retry_committed","store_comm","account_a","nonce_committed","c".repeat(64),packet,expires,300),"replay");assert.equal(await app.recordPluginEvidence("conflict","store_comm","account_a","nonce_committed","d".repeat(64),packet,expires,300),"conflict");
  assert.ok(await app.getActivePluginEvidence("store_comm","account_a"));assert.equal((raw.prepare("SELECT COUNT(*) n FROM release_gate_evidence_commits WHERE state!='COMMITTED'").get() as {n:number}).n,0);assert.equal((raw.prepare("SELECT COUNT(*) n FROM release_gate_active_evidence").get() as {n:number}).n,3);
  assert.equal(await app.recordPluginEvidence("receipt_a","store_order","account_a","nonce_a","e".repeat(64),'{"state":"PASS"}',expires,1000),"stored");assert.equal(await app.recordPluginEvidence("receipt_b","store_order","account_a","nonce_b","f".repeat(64),'{"state":"FAIL"}',expires,2000),"stored");assert.equal((await app.getActivePluginEvidence("store_order","account_a"))?.receiptId,"receipt_b");const replays=await Promise.all(Array.from({length:10},()=>app.recordPluginEvidence("retry_a","store_order","account_a","nonce_a","e".repeat(64),'{"state":"PASS"}',expires,1000)));assert.ok(replays.every(x=>x==="replay"));assert.equal((await app.getActivePluginEvidence("store_order","account_a"))?.receiptId,"receipt_b","a replay cannot roll active evidence backward");
});
