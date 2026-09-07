import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { evidenceIsSafe, createEvidencePacket } from "../src/releaseGate/evidence.ts";
import { verifyMcp } from "../src/releaseGate/mcpVerifier.ts";
import { PROTOCOL_BUNDLES } from "../src/releaseGate/protocolBundles.ts";
import { verifyUcpProfile } from "../src/releaseGate/ucpVerifier.ts";
import { verifyAcpProfile } from "../src/releaseGate/acpVerifier.ts";
import { isPublicAddress, TargetGuard, type TargetResolver } from "../src/releaseGate/targetGuard.ts";
import { runPreflight } from "../src/releaseGate/preflight.ts";
import { AppStore } from "../src/core/appStore.ts";
import { ReleaseGateStore } from "../src/releaseGate/store.ts";
import { sqliteD1 } from "./helpers/sqlite.ts";

const rpc=(id:string,result:Record<string,unknown>)=>({jsonrpc:"2.0",id,result});
const schema={type:"object",properties:{},additionalProperties:false};
test("vendored protocol and vector hashes are recomputable",async()=>{
  const manifest=JSON.parse(await readFile(new URL("../protocol-fixtures/manifest.json",import.meta.url),"utf8")) as {artifacts:Array<{path:string;sha256:string}>};
  for(const a of manifest.artifacts){const bytes=await readFile(new URL(`../${a.path}`,import.meta.url));assert.equal(createHash("sha256").update(bytes).digest("hex"),a.sha256);}
  assert.equal(PROTOCOL_BUNDLES.find(x=>x.family==="mcp")?.vectorSha256,"404ad329fc4b3059b35a202262ef2d1333c33373de5fe0365fa35d0b77c4b912");
});
test("MCP verification performs all five safe JSON-RPC exchanges",async()=>{
  const methods:string[]=[];const transport={async call(m:Record<string,unknown>){methods.push(String(m.method));if(m.method==="notifications/initialized")return null;if(m.method==="initialize")return rpc(String(m.id),{protocolVersion:"2025-06-18"});if(m.method==="ping")return rpc(String(m.id),{});if(m.method==="tools/list")return rpc(String(m.id),{tools:[{name:"release_gate_self_check",inputSchema:schema,outputSchema:schema,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}]});return rpc(String(m.id),{content:[]});}};
  const checks=await verifyMcp(transport,["release_gate_self_check"]);assert.deepEqual(methods,["initialize","notifications/initialized","ping","tools/list","tools/call"]);assert.equal(checks.at(-1)?.state,"PASS");
});
test("preflight invokes the MCP verifier instead of accepting discovery HTTP 200",async()=>{
  const calls:string[]=[];const transport={async call(m:Record<string,unknown>){calls.push(String(m.method));if(m.method==="notifications/initialized")return null;if(m.method==="initialize")return rpc(String(m.id),{protocolVersion:"2025-06-18"});if(m.method==="ping")return rpc(String(m.id),{});if(m.method==="tools/list")return rpc(String(m.id),{tools:[{name:"release_gate_self_check",inputSchema:schema,outputSchema:schema,annotations:{readOnlyHint:true}}]});return rpc(String(m.id),{content:[]});}};
  const resolver:TargetResolver={async resolve(){return["8.8.8.8"];}};const result=await runPreflight({store_origin:"https://shop.example",requested_families:["mcp"]},{resolver,connectionBinding:"verified",mcpTransport:transport,fetchImpl:async()=>new Response(JSON.stringify({endpoint:"https://probe.invalid"}),{headers:{"content-type":"application/json"}})});
  assert.deepEqual(calls,["initialize","notifications/initialized","ping","tools/list","tools/call"]);assert.equal(result.checks.find(x=>x.id==="mcp-tools-call")?.state,"PASS");
});
test("MCP rejects version, unsafe annotations, malformed output schemas, and tool errors",async()=>{
  const invalid={async call(m:Record<string,unknown>){if(m.method==="initialize")return rpc("initialize",{protocolVersion:"wrong"});return null;}};assert.equal((await verifyMcp(invalid,["release_gate_self_check"]))[0].state,"FAIL");
  const unsafe={async call(m:Record<string,unknown>){if(m.method==="initialize")return rpc("initialize",{protocolVersion:"2025-06-18"});if(m.method==="notifications/initialized")return null;if(m.method==="ping")return rpc("ping",{});return rpc(String(m.id),{tools:[{name:"release_gate_self_check",inputSchema:schema,outputSchema:{type:"array"},annotations:{readOnlyHint:false}}]});}};assert.equal((await verifyMcp(unsafe,["release_gate_self_check"])).at(-1)?.reasonCode,"MCP_TOOL_ANNOTATION_UNSAFE");
});
test("UCP and ACP unsupported or malformed declarations cannot pass",()=>{
  const ucp=PROTOCOL_BUNDLES.find(x=>x.family==="ucp")!,acp=PROTOCOL_BUNDLES.find(x=>x.family==="acp")!;
  assert.equal(verifyUcpProfile({version:ucp.release,capabilities:[{name:"payment"}]},ucp)[0].state,"NOT_APPLICABLE");
  assert.equal(verifyUcpProfile({version:ucp.release,capabilities:[{}]},ucp)[0].state,"FAIL");
  assert.equal(verifyAcpProfile({version:acp.release,api_url:"http://unsafe.test",feed_url:"https://safe.test/feed"},acp)[0].state,"FAIL");
});
test("target policy blocks IANA special ranges and requires an attested fetch binding",async()=>{
  for(const ip of ["0.0.0.0","10.1.2.3","100.64.0.1","127.0.0.1","169.254.1.1","172.16.1.1","192.0.2.1","198.51.100.1","203.0.113.1","224.0.0.1","::1","fc00::1","fe80::1","2001:db8::1","::ffff:127.0.0.1"])assert.equal(isPublicAddress(ip),false,ip);
  const resolver:TargetResolver={async resolve(){return["8.8.8.8"];}};const guard=new TargetGuard({resolver,fetchImpl:async()=>new Response("ok")});await assert.rejects(()=>guard.fetch("https://shop.example"),/CONNECTION_UNVERIFIABLE/);
  const lied=new TargetGuard({resolver,connectionBinding:"verified",maxBytes:5,fetchImpl:async()=>new Response("0123456789",{headers:{"content-length":"1"}})});await assert.rejects(()=>lied.text("https://shop.example"),/TARGET_BYTES_EXCEEDED/);
});
test("preflight records malformed MIME as unmeasured rather than parsing it",async()=>{
  const resolver:TargetResolver={async resolve(){return["8.8.8.8"];}};
  const value=await runPreflight({store_origin:"https://shop.example",requested_families:["woo"]},{resolver,connectionBinding:"verified",fetchImpl:async()=>new Response("not-json",{headers:{"content-type":"image/png"}})});
  assert.equal(value.checks[0].reasonCode,"INVALID_MIME");assert.equal(value.state,"UNMEASURED");
});
test("evidence rejects raw identifiers, raw URLs, sensitive strings, and unknown fields without redaction",async()=>{
  for(const evidence of [{status:200,unexpected:true},{status:200,raw:"https://merchant.example/a"},{status:200,raw:"buyer@example.com"}])await assert.rejects(()=>createEvidencePacket("run_12345678","REJECTED",[{id:"woo-store-api",family:"woo",state:"FAIL",reasonCode:"WOO_API_UNAVAILABLE",evidence:evidence as unknown as Record<string,string|number|boolean|null>}],[],["woo"],0,null,[]));
  const packet=await createEvidencePacket("run_12345678","REJECTED",[{id:"woo-store-api",family:"woo",state:"FAIL",reasonCode:"WOO_API_UNAVAILABLE",evidence:{status:503,sample_count:0,catalogue_total:null,page_count:0,mime_valid:true}}],[],["woo"],0,null,[]);assert.equal(evidenceIsSafe(packet),true);
});
test("ten concurrent claim attempts have exactly one billable winner and no settlement rows",async()=>{
  const {db,raw}=sqliteD1(),app=new AppStore(db),gate=new ReleaseGateStore(app);const run=await gate.createOrGetRun("account_1",{store_id:"store_123",mode:"owned-safe-active",requested_families:["woo"],idempotency_key:"claim_matrix_123456"});
  const packet=await createEvidencePacket(run.id,"ACCEPTED",[{id:"woo-store-api",family:"woo",state:"PASS",evidence:{status:200,sample_count:1,catalogue_total:1,page_count:1,mime_valid:true}}],[],["woo"],1,1,[]);await gate.publish(run,"ACCEPTED",JSON.stringify(packet),packet.digest);const terminal=(await gate.getRun(run.id,"account_1"))!;
  const values=await Promise.all(Array.from({length:10},(_,i)=>gate.claim(terminal,"direct",`identity_${i}`)));assert.equal(values.filter(x=>x.billable).length,1);assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM release_gate_billable_claims").get() as {n:number}).n,1);assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='financial_operations'").get(),undefined);
});
