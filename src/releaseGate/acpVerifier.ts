import type { ReleaseCheck, ProtocolBundle } from "./types.ts";
const out=(state:ReleaseCheck["state"],reasonCode:ReleaseCheck["reasonCode"],evidence:ReleaseCheck["evidence"]):ReleaseCheck=>({id:"acp-profile",family:"acp",state,...(reasonCode?{reasonCode}:{}),evidence});
const secureUrl=(v:unknown)=>typeof v==="string"&&(()=>{try{return new URL(v).protocol==="https:";}catch{return false;}})();
/** ACP profile review only proves HTTPS declaration shape; it does not authorize payment. */
export function verifyAcpProfile(value:unknown,bundle:ProtocolBundle):ReleaseCheck[]{
  if(!value||typeof value!=="object"||Array.isArray(value))return[out("FAIL","ACP_PROFILE_INVALID",{api_declared:false,feed_declared:false,version_matches:false})];
  const p=value as Record<string,unknown>,version=p.version??p.acp_version,api=secureUrl(p.api_url??p.checkout_api),feed=secureUrl(p.feed_url);
  if(version!==bundle.release)return[out("FAIL","PROTOCOL_VERSION_UNSUPPORTED",{api_declared:api,feed_declared:feed,version_matches:false})];
  return[out(api&&feed?"PASS":"FAIL",api&&feed?undefined:"ACP_PROFILE_INVALID",{api_declared:api,feed_declared:feed,version_matches:true})];
}
