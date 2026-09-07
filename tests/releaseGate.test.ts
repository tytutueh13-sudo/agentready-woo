import test from "node:test";
import assert from "node:assert/strict";
import { AppStore } from "../src/core/appStore.ts";
import { sqliteD1 } from "./helpers/sqlite.ts";
import { classify } from "../src/releaseGate/classifier.ts";
import { createEvidencePacket, evidenceIsSafe } from "../src/releaseGate/evidence.ts";
import { runPreflight } from "../src/releaseGate/preflight.ts";
import { ReleaseGateStore } from "../src/releaseGate/store.ts";
import { TargetGuard, TargetGuardError, type TargetResolver } from "../src/releaseGate/targetGuard.ts";
import { executeAcceptanceRun } from "../src/workflows/acceptanceRun.ts";

const resolver: TargetResolver = { async resolve() { return ["8.8.8.8"]; } };
const response = (value: unknown, headers: Record<string,string> = {}) => new Response(JSON.stringify(value), { status: 200, headers });
const fetchFixture = async (input: string | URL): Promise<Response> => { const u = new URL(String(input)); if (u.pathname === "/wp-json/wc/store/v1/products") return response([{id:2,permalink:"https://shop.example/p/2"}],{"x-wp-total":"2","content-type":"application/json"}); if (u.pathname.startsWith("/p/")) return new Response('<script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer"}}</script>',{headers:{"content-type":"text/html"}}); if (u.pathname === "/robots.txt") return new Response("User-agent: OAI-SearchBot\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /",{headers:{"content-type":"text/plain"}}); if (u.pathname === "/.well-known/mcp.json") return response({version:"2025-06-18"},{"content-type":"application/json"}); return new Response("missing",{status:404,headers:{"content-type":"text/plain"}}); };

test("preflight uses total header, deterministic product pages, and separated crawler evidence", async () => {
  const result = await runPreflight({store_origin:"https://shop.example",requested_families:["woo","robots","jsonld","mcp"]},{resolver,fetchImpl:fetchFixture,connectionBinding:"verified",now:()=>new Date("2026-09-06T00:00:00Z")});
  assert.equal(result.catalogue_total,2); assert.equal(result.sample_size,2); assert.equal(result.checks.find(x=>x.id==="product-jsonld")?.state,"PASS");
  const robots=result.checks.find(x=>x.id==="robots-crawler-policy"); assert.equal(robots?.evidence.training,false); assert.equal(robots?.evidence.search,true);
});
test("target guard rejects private DNS, unsafe redirects, rebinding, and overlarge responses", async () => {
  const privateResolver: TargetResolver={async resolve(){return ["127.0.0.1"];}}; await assert.rejects(()=>new TargetGuard({resolver:privateResolver,fetchImpl:fetchFixture}).validate("https://shop.example"), TargetGuardError);
  const redirects = new TargetGuard({resolver,connectionBinding:"verified",fetchImpl:async()=>new Response(null,{status:302,headers:{location:"http://127.0.0.1/"}})}); await assert.rejects(()=>redirects.fetch("https://shop.example"),/TARGET_REDIRECT_UNSAFE/);
  const large = new TargetGuard({resolver,connectionBinding:"verified",fetchImpl:async()=>new Response("x",{headers:{"content-length":"300000"}}),maxBytes:10}); await assert.rejects(()=>large.fetch("https://shop.example"),/TARGET_BYTES_EXCEEDED/);
});
test("classification abstains before it accepts and evidence refuses sensitive keys", async () => {
  assert.equal(classify([{id:"x",family:"woo",state:"UNMEASURED",evidence:{}}],["woo"]),"UNMEASURED");
  await assert.rejects(()=>createEvidencePacket("run_12345678","ACCEPTED",[{id:"woo-store-api",family:"woo",state:"PASS",evidence:{description:"private",status:200}}],[],["woo"],1,1,[]));
  const packet=await createEvidencePacket("run_12345678","ACCEPTED",[{id:"woo-store-api",family:"woo",state:"PASS",evidence:{status:200,sample_count:1,catalogue_total:1,page_count:1,mime_valid:true}}],[],["woo"],1,1,[]); assert.equal(evidenceIsSafe(packet),true);
});
test("release run migration, idempotency, first delivery, and non-settlement are isolated", async () => {
  const {db,raw}=sqliteD1(); const app=new AppStore(db); await app.ensureSchema(); assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE name='release_gate_runs'").get());
  const gate=new ReleaseGateStore(app); const input={store_id:"store_123",mode:"owned-safe-active" as const,requested_families:["woo"] as "woo"[],idempotency_key:"idem_1234567890123456"}; const a=await gate.createOrGetRun("account_1",input); const b=await gate.createOrGetRun("account_1",input); assert.equal(a.id,b.id);
  const packet=await createEvidencePacket(a.id,"REJECTED",[{id:"woo-store-api",family:"woo",state:"FAIL",reasonCode:"WOO_API_UNAVAILABLE",evidence:{status:503,sample_count:0,catalogue_total:null,page_count:0,mime_valid:true}}],[],["woo"],1,1,[]); assert.equal(await gate.publish(a,"REJECTED",JSON.stringify(packet),packet.digest),true); const terminal=await gate.getRun(a.id,"account_1"); assert.equal(terminal?.terminalState,"REJECTED");
  const first=await gate.claim(terminal!,"direct","account-digest"); const repeat=await gate.claim(terminal!,"direct","account-digest"); assert.equal(first.firstDelivery,true); assert.equal(first.billable,true); assert.equal(repeat.firstDelivery,false); assert.equal(repeat.billable,false); assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='financial_operations'").get(),undefined,"release claim must not create or enter a settlement ledger");
});
test("workflow refuses a non-ephemeral active flow before publication", async () => {
  const {db}=sqliteD1(); const app=new AppStore(db); const gate=new ReleaseGateStore(app); const run=await gate.createOrGetRun("account_1",{store_id:"store_123",mode:"owned-safe-active",requested_families:["woo"],idempotency_key:"idem_workflow_12345"});
  const state=await executeAcceptanceRun(run,"https://shop.example",gate,{resolver,fetchImpl:fetchFixture,connectionBinding:"verified"},{sideEffects:"ephemeral-session-only",async run(){return [{id:"forbidden",family:"woo",state:"BLOCKED",reasonCode:"ACTIVE_FLOW_FORBIDDEN",evidence:{}}];}}); assert.equal(state,"BLOCKED");
});
