// JSON-RPC 2.0 / Model Context Protocol transport.
//
// The /mcp endpoints accepted `{tool, input}` and nothing else. That is a
// perfectly good JSON API, but it is not MCP: a real client opens with
// `initialize`, asks `tools/list`, then calls `tools/call`, all as JSON-RPC
// 2.0. Sending that to the old endpoint got back
// `missing "tool" — this endpoint serves one tool`, so no MCP client could
// connect at all, while the public copy called it a Model Context Protocol
// endpoint.
//
// This layer speaks the protocol and knows nothing about any particular tool.
// The tools themselves are passed in, so the service keeps its own logic and
// this file stays testable without a database.

/** Protocol revisions this server can speak, newest first.
 *
 * `initialize` echoes the client's version when it is one of these, and
 * otherwise answers with the newest we know — which is what the spec asks
 * for, and lets a newer client decide whether it can proceed rather than
 * failing the handshake outright. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export interface McpTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments, as `tools/list` returns it. */
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?:boolean; destructiveHint?:boolean; openWorldHint?:boolean };
  /** A failure here is a TOOL failure, not a protocol failure: it comes back
   * as a normal result carrying `isError: true`, because the call itself was
   * well-formed and the model needs to see what went wrong. */
  /** Request metadata is explicit so authenticated tools never need to infer
   * credentials from arguments. Existing public tools may ignore it. */
  run(args: Record<string, unknown>, context?: McpToolContext): Promise<{ ok: true; text: string } | { ok: false; text: string }>;
}
export interface McpToolContext { authorization?: string; }

export interface McpServerInfo {
  name: string;
  version: string;
  /** Optional guidance a client may show to the model on connect. */
  instructions?: string;
}

type Id = string | number | null;

/** JSON-RPC 2.0 error codes. The last three are the ones that actually occur
 * here; the parse/invalid-request pair is raised by the caller. */
export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export function rpcError(id: Id, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

function rpcResult(id: Id, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

/** True when a body is a JSON-RPC message (or a batch of them), which is what
 * separates an MCP client from a caller using the older `{tool, input}` shape
 * this endpoint still accepts. */
export function isJsonRpc(body: unknown): boolean {
  if (Array.isArray(body)) return body.length > 0 && body.every(isJsonRpc);
  return Boolean(body) && typeof body === "object"
    && (body as Record<string, unknown>).jsonrpc === "2.0";
}

async function handleOne(
  message: unknown, server: McpServerInfo, tools: McpTool[], context?: McpToolContext,
): Promise<Record<string, unknown> | null> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, RPC.INVALID_REQUEST, "message must be a JSON-RPC 2.0 object");
  }
  const m = message as Record<string, unknown>;
  if (m.jsonrpc !== "2.0") return rpcError(null, RPC.INVALID_REQUEST, "jsonrpc must be \"2.0\"");
  const method = typeof m.method === "string" ? m.method : "";
  // A message with no id is a notification: the spec requires no reply, and
  // sending one anyway is a protocol violation rather than a harmless extra.
  const isNotification = !("id" in m) || m.id === undefined;
  const id = (isNotification ? null : m.id) as Id;
  const params = (m.params && typeof m.params === "object" && !Array.isArray(m.params)
    ? m.params : {}) as Record<string, unknown>;

  if (isNotification) {
    // `notifications/initialized` is the only one a client sends us, and it
    // needs no action from a stateless server. Anything else is ignored on
    // purpose — an unknown notification must not become an error reply.
    return null;
  }

  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(asked)
        ? asked : LATEST_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        // Only tools. Declaring resources or prompts we do not serve would
        // make a client ask for things that are not there.
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: server.version },
        ...(server.instructions ? { instructions: server.instructions } : {}),
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.outputSchema?{outputSchema:t.outputSchema}:{}), ...(t.annotations?{annotations:t.annotations}:{}) })),
      });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const tool = tools.find(t => t.name === name);
      // An unknown tool is a malformed CALL, not a failed one — the spec puts
      // it in the protocol error channel so a client can tell the difference.
      if (!tool) {
        return rpcError(id, RPC.INVALID_PARAMS,
          `unknown tool: ${name.slice(0, 100) || "(missing)"}`,
          { available: tools.map(t => t.name) });
      }
      const args = (params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
        ? params.arguments : {}) as Record<string, unknown>;
      try {
        const out = await tool.run(args, context);
        return rpcResult(id, {
          content: [{ type: "text", text: out.text }],
          ...(out.ok ? {} : { isError: true }),
        });
      } catch (err) {
        // A thrown tool is still a tool failure: reporting it as a protocol
        // error would tell the client the request was malformed when it was
        // not, and the model would have nothing to act on.
        return rpcResult(id, {
          content: [{ type: "text", text: `tool failed: ${err instanceof Error ? err.message : "unknown error"}` }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(id, RPC.METHOD_NOT_FOUND, `unknown method: ${method.slice(0, 100) || "(missing)"}`);
  }
}

/** Handle one JSON-RPC message or a batch.
 *
 * Returns null when every message was a notification — the caller answers 202
 * with no body, because a JSON-RPC response to a notification is not allowed. */
export async function handleJsonRpc(
  body: unknown, server: McpServerInfo, tools: McpTool[], context?: McpToolContext,
): Promise<unknown | null> {
  if (Array.isArray(body)) {
    if (body.length === 0) return rpcError(null, RPC.INVALID_REQUEST, "batch must not be empty");
    const out: Record<string, unknown>[] = [];
    for (const message of body) {
      const reply = await handleOne(message, server, tools, context);
      if (reply) out.push(reply);
    }
    return out.length ? out : null;
  }
  return await handleOne(body, server, tools, context);
}
