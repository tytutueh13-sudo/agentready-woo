import type { ReleaseCheck, ProtocolBundle } from "./types.ts";
const out=(state:ReleaseCheck["state"],reasonCode:ReleaseCheck["reasonCode"],evidence:ReleaseCheck["evidence"]):ReleaseCheck=>({id:"ucp-profile",family:"ucp",state,...(reasonCode?{reasonCode}:{}),evidence});
/** Mechanical, non-payment UCP declaration check. Unsupported payment vectors are not accepted. */
export function verifyUcpProfile(value:unknown,bundle:ProtocolBundle):ReleaseCheck[]{
  if(!value||typeof value!=="object"||Array.isArray(value))return[out("FAIL","UCP_PROFILE_INVALID",{capability_count:0,version_matches:false})];
  const p=value as Record<string,unknown>,version=p.version??p.ucp_version,caps=p.capabilities;
  if(version!==bundle.release)return[out("FAIL","PROTOCOL_VERSION_UNSUPPORTED",{capability_count:Array.isArray(caps)?caps.length:0,version_matches:false})];
  if(!Array.isArray(caps)||caps.some(x=>!x||typeof x!=="object"||Array.isArray(x)||typeof(x as Record<string,unknown>).name!=="string"))return[out("FAIL","UCP_PROFILE_INVALID",{capability_count:0,version_matches:true})];
  const names=caps.map(x=>(x as Record<string,unknown>).name as string);if(names.some(n=>/payment|checkout/i.test(n)))return[out("NOT_APPLICABLE","PROTOCOL_VERSION_UNSUPPORTED",{capability_count:names.length,version_matches:true})];
  return[out("PASS",undefined,{capability_count:names.length,version_matches:true})];
}
