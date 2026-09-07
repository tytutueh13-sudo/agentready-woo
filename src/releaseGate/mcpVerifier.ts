import type { ReleaseCheck } from "./types.ts";

export interface McpTransport { call(message: Record<string, unknown>): Promise<unknown>; }
type RpcResult = Record<string, unknown>;
const check=(id:string,state:ReleaseCheck["state"],reasonCode:ReleaseCheck["reasonCode"],evidence:ReleaseCheck["evidence"]):ReleaseCheck=>({id,family:"mcp",state,...(reasonCode?{reasonCode}:{}),evidence});
function result(value:unknown):RpcResult|null{if(!value||typeof value!=="object"||Array.isArray(value))return null;const r=value as Record<string,unknown>;return r.jsonrpc==="2.0"&&"id"in r&&r.result&&typeof r.result==="object"&&!Array.isArray(r.result)?r.result as RpcResult:null;}
function notification(value:unknown):boolean{return value===null||value===undefined||value&&typeof value==="object"&&(value as Record<string,unknown>).jsonrpc==="2.0"&&!("id"in(value as Record<string,unknown>));}
function objectSchema(value:unknown):boolean{return!!value&&typeof value==="object"&&!Array.isArray(value)&&(value as Record<string,unknown>).type==="object"&&typeof(value as Record<string,unknown>).properties==="object";}
function readOnly(value:unknown):boolean{if(!value||typeof value!=="object")return false;const a=value as Record<string,unknown>;return a.readOnlyHint===true&&a.destructiveHint!==true&&a.openWorldHint!==true;}

/** Executes only a declared, read-only self-check. It never calls merchant tools. */
export async function verifyMcp(transport:McpTransport,allowedReadOnlyTools:readonly string[]=[]):Promise<ReleaseCheck[]>{
  const checks:ReleaseCheck[]=[];
  let initialized:RpcResult|null;
  try{initialized=result(await transport.call({jsonrpc:"2.0",id:"initialize",method:"initialize",params:{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"agentready-release-gate",version:"1"}}}));}catch{return[check("mcp-initialize","UNMEASURED","UNMEASURED_SOURCE",{})];}
  if(!initialized||initialized.protocolVersion!=="2025-06-18")return[check("mcp-initialize","FAIL","MCP_INITIALIZE_FAILED",{})];
  checks.push(check("mcp-initialize","PASS",undefined,{protocol_version:"2025-06-18"}));
  try{if(!notification(await transport.call({jsonrpc:"2.0",method:"notifications/initialized",params:{}})))return[...checks,check("mcp-initialize","FAIL","MCP_INITIALIZE_FAILED",{})];}catch{return[...checks,check("mcp-initialize","UNMEASURED","UNMEASURED_SOURCE",{})];}
  try{if(!result(await transport.call({jsonrpc:"2.0",id:"ping",method:"ping",params:{}})))return[...checks,check("mcp-ping","FAIL","MCP_INITIALIZE_FAILED",{ok:false})];checks.push(check("mcp-ping","PASS",undefined,{ok:true}));}catch{return[...checks,check("mcp-ping","UNMEASURED","UNMEASURED_SOURCE",{ok:false})];}
  let listed:RpcResult|null;try{listed=result(await transport.call({jsonrpc:"2.0",id:"tools-list",method:"tools/list",params:{}}));}catch{return[...checks,check("mcp-tools-list","UNMEASURED","UNMEASURED_SOURCE",{})];}
  const tools=Array.isArray(listed?.tools)?listed.tools as Record<string,unknown>[]:null;if(!tools)return[...checks,check("mcp-tools-list","FAIL","MCP_TOOLS_LIST_FAILED",{})];
  checks.push(check("mcp-tools-list","PASS",undefined,{tool_count:tools.length}));
  const selected=tools.find(t=>typeof t.name==="string"&&allowedReadOnlyTools.includes(t.name));
  if(!selected||!objectSchema(selected.inputSchema)||!objectSchema(selected.outputSchema)||!readOnly(selected.annotations))return[...checks,check("mcp-tool-contract","FAIL",!selected?"MCP_TOOLS_LIST_FAILED":!readOnly(selected.annotations)?"MCP_TOOL_ANNOTATION_UNSAFE":"PROTOCOL_SCHEMA_INVALID",{reviewed_tools:tools.length})];
  checks.push(check("mcp-tool-contract","PASS",undefined,{reviewed_tools:tools.length}));
  try{const called=result(await transport.call({jsonrpc:"2.0",id:"tools-call",method:"tools/call",params:{name:selected.name,arguments:{}}}));if(!called||called.isError===true||!Array.isArray(called.content))return[...checks,check("mcp-tools-call","FAIL","MCP_TOOL_CALL_FAILED",{ok:false})];checks.push(check("mcp-tools-call","PASS",undefined,{ok:true}));}catch{return[...checks,check("mcp-tools-call","UNMEASURED","UNMEASURED_SOURCE",{ok:false})];}
  return checks;
}
