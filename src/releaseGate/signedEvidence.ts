import type { PluginEvidence } from "./pluginEvidence.ts";
import type { ReasonCode, ReleaseCheck, ReleaseFamily } from "./types.ts";

const FAMILY_CHECK:Record<ReleaseFamily,string>={woo:"woo_rollup",robots:"robots_rollup",jsonld:"jsonld_rollup",mcp:"mcp_rollup",ucp:"ucp_rollup",acp:"acp_rollup"};
const FAILURE:Record<ReleaseFamily,ReasonCode>={woo:"WOO_API_UNAVAILABLE",robots:"ROBOTS_BLOCKED",jsonld:"JSONLD_PRODUCT_MISSING",mcp:"MCP_TOOL_CALL_FAILED",ucp:"UCP_PROFILE_INVALID",acp:"ACP_PROFILE_INVALID"};
const FAMILIES=new Set<ReleaseFamily>(Object.keys(FAMILY_CHECK) as ReleaseFamily[]);

/** Converts the deliberately small plugin aggregate vocabulary into Release
 * checks. The key set is closed: plugin-provided names never become evidence
 * ids or reason codes in a customer decision. */
export function pluginEvidenceChecks(packet:PluginEvidence,requested:ReleaseFamily[]):ReleaseCheck[]{
  if(packet.families.some(f=>!FAMILIES.has(f as ReleaseFamily)))throw new Error("EVIDENCE_INVALID");
  const declared=new Set(packet.families as ReleaseFamily[]);const allowed=new Set(Object.values(FAMILY_CHECK));
  if(Object.keys(packet.checks).some(k=>!allowed.has(k)))throw new Error("EVIDENCE_INVALID");
  return requested.map(family=>{const aggregate=packet.checks[FAMILY_CHECK[family]];if(!declared.has(family)||!aggregate)return{id:`plugin-${family}-rollup`,family,state:"UNMEASURED",reasonCode:"UNMEASURED_SOURCE",evidence:{count:0}};if(aggregate.state==="PASS")return{id:`plugin-${family}-rollup`,family,state:"PASS",evidence:{count:aggregate.count}};if(aggregate.state==="FAIL")return{id:`plugin-${family}-rollup`,family,state:"FAIL",reasonCode:family==="woo"&&aggregate.count===0?"WOO_SAMPLE_EMPTY":FAILURE[family],evidence:{count:aggregate.count}};return{id:`plugin-${family}-rollup`,family,state:"UNMEASURED",reasonCode:"UNMEASURED_SOURCE",evidence:{count:aggregate.count}};});
}
export function evidenceCoversFamilies(packet:PluginEvidence,requested:ReleaseFamily[]):boolean{return requested.every(f=>packet.families.includes(f)&&Object.hasOwn(packet.checks,FAMILY_CHECK[f]));}
