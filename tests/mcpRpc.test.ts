// The store endpoint was called a Model Context Protocol endpoint while
// answering only `{tool, input}`. A real client opens with initialize, asks tools/list,
// then calls tools/call — all JSON-RPC 2.0 — and got back
// `missing "tool"`, so none could connect. These tests walk that exact
// handshake.
import test from "node:test";
import assert from "node:assert/strict";
import {
  handleJsonRpc, isJsonRpc, rpcError, RPC,
  LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, type McpTool,
} from "../src/core/mcpRpc.ts";

const SERVER = { name: "test-server", version: "9.9.9", instructions: "be careful" };
const TOOLS: McpTool[] = [{
  name: "demo_tool",
  description: "does a thing",
  inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  async run(args) {
    if (args.q === "boom") throw new Error("exploded");
    if (args.q === "bad") return { ok: false, text: "no such thing" };
    return { ok: true, text: `ran with ${String(args.q)}` };
  },
}];
const call = (m: unknown) => handleJsonRpc(m, SERVER, TOOLS);
const req = (method: string, params?: unknown, id: unknown = 1) =>
  ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

test("recognises JSON-RPC and leaves the older shape alone", () => {
  assert.equal(isJsonRpc({ jsonrpc: "2.0", id: 1, method: "ping" }), true);
  assert.equal(isJsonRpc([{ jsonrpc: "2.0", id: 1, method: "ping" }]), true);
  assert.equal(isJsonRpc({ tool: "x", input: {} }), false);
  assert.equal(isJsonRpc([]), false);
  assert.equal(isJsonRpc(null), false);
});

test("initialize answers with capabilities and server identity", async () => {
  const r = await call(req("initialize", { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {} })) as any;
  assert.equal(r.jsonrpc, "2.0");
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.deepEqual(r.result.serverInfo, { name: "test-server", version: "9.9.9" });
  // Only tools are declared — announcing resources or prompts we do not serve
  // would send a client looking for things that are not there.
  assert.deepEqual(Object.keys(r.result.capabilities), ["tools"]);
  assert.equal(r.result.instructions, "be careful");
});

test("initialize echoes any revision we support", async () => {
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
    const r = await call(req("initialize", { protocolVersion: v })) as any;
    assert.equal(r.result.protocolVersion, v);
  }
});

// Answering with our own version lets a newer client decide whether it can
// proceed, instead of failing the handshake outright.
test("initialize falls back to our newest for a version we do not know", async () => {
  const r = await call(req("initialize", { protocolVersion: "2099-01-01" })) as any;
  assert.equal(r.result.protocolVersion, LATEST_PROTOCOL_VERSION);
});

test("tools/list returns the schema a model reads", async () => {
  const r = await call(req("tools/list")) as any;
  assert.equal(r.result.tools.length, 1);
  assert.equal(r.result.tools[0].name, "demo_tool");
  assert.deepEqual(r.result.tools[0].inputSchema.required, ["q"]);
});

test("tools/call returns text content", async () => {
  const r = await call(req("tools/call", { name: "demo_tool", arguments: { q: "hi" } })) as any;
  assert.deepEqual(r.result.content, [{ type: "text", text: "ran with hi" }]);
  assert.equal(r.result.isError, undefined);
});

// A tool that ran and failed is not a malformed request: the model has to see
// what went wrong, so it comes back as a result carrying isError.
test("a failing tool is a result with isError, not a protocol error", async () => {
  const r = await call(req("tools/call", { name: "demo_tool", arguments: { q: "bad" } })) as any;
  assert.equal(r.error, undefined);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /no such thing/);
});

test("a tool that throws is caught and reported the same way", async () => {
  const r = await call(req("tools/call", { name: "demo_tool", arguments: { q: "boom" } })) as any;
  assert.equal(r.error, undefined);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /exploded/);
});

// An unknown tool IS a malformed call, and the spec puts it in the protocol
// error channel so a client can tell the two apart.
test("an unknown tool is a protocol error listing what is available", async () => {
  const r = await call(req("tools/call", { name: "nope" })) as any;
  assert.equal(r.error.code, RPC.INVALID_PARAMS);
  assert.deepEqual(r.error.data.available, ["demo_tool"]);
});

test("an unknown method is method-not-found", async () => {
  const r = await call(req("resources/list")) as any;
  assert.equal(r.error.code, RPC.METHOD_NOT_FOUND);
});

test("ping answers empty, which is what it is for", async () => {
  const r = await call(req("ping")) as any;
  assert.deepEqual(r.result, {});
});

// Replying to a notification is a protocol violation, not a harmless extra.
test("notifications get no reply at all", async () => {
  assert.equal(await call({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(await call({ jsonrpc: "2.0", method: "notifications/something-new" }), null);
});

test("a batch answers each request and drops the notifications", async () => {
  const r = await call([
    req("ping", undefined, "a"),
    { jsonrpc: "2.0", method: "notifications/initialized" },
    req("tools/list", undefined, "b"),
  ]) as any[];
  assert.equal(r.length, 2);
  assert.deepEqual(r.map(x => x.id), ["a", "b"]);
});

test("a batch of only notifications produces no body", async () => {
  assert.equal(await call([{ jsonrpc: "2.0", method: "notifications/initialized" }]), null);
});

test("a message that is not JSON-RPC 2.0 is rejected as an invalid request", async () => {
  const r = await call({ jsonrpc: "1.0", id: 1, method: "ping" }) as any;
  assert.equal(r.error.code, RPC.INVALID_REQUEST);
  assert.equal(await call([]) !== null, true);
});

test("rpcError carries data only when given some", () => {
  assert.equal("data" in rpcError(1, RPC.INTERNAL_ERROR, "x"), false);
  assert.equal((rpcError(1, RPC.INTERNAL_ERROR, "x", { a: 1 }) as any).error.data.a, 1);
});
