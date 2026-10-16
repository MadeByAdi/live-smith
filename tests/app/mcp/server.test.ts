import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { URL } from "node:url";
import test from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createMcpServerClient, authenticateMcpServerClient, revokeMcpServerClient } from "../../../src/storage/mcp-server-auth.js";

test("MCP HTTP exposes canonical schemas and executes only authenticated Session tools", async () => {
  const module = await import("../../../src/app/mcp/server.js").catch(() => undefined);
  assert.equal(typeof module?.createMcpHttpServer, "function");
  const directory = await mkdtemp(join(tmpdir(), "mcp-server-"));
  let total = 0;
  const grant = await createMcpServerClient(directory, { name: "Test", projectKey: "set", sessionId: "session" });
  const schema = { type: "object", properties: { beats: { type: "number", minimum: 1 } }, required: ["beats"], additionalProperties: false };
  const server = await module!.createMcpHttpServer({ port: 0,
    authenticate: (token) => authenticateMcpServerClient(directory, token),
    tools: async () => [{ type: "function", function: { name: "add_beats", description: "Append beats", parameters: schema } }],
    callTool: async (client, name, args) => {
      assert.equal(client.sessionId, "session"); assert.equal(name, "add_beats");
      total += (args as { beats: number }).beats;
      return { content: [{ type: "text", text: String(total) }] };
    },
  });
  const client = new Client({ name: "integration", version: "1" }, { versionNegotiation: { mode: "auto" } });
  try {
    assert.equal((await fetch(server.url, { method: "POST" })).status, 401);
    assert.equal((await fetch(server.url, { headers: { Authorization: `Bearer ${grant.token}`, Origin: "https://hostile.example" } })).status, 403);
    const forged = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(server.url, { headers: { Host: "hostile.example", Authorization: `Bearer ${grant.token}` } }, response => { response.resume(); resolve(response.statusCode!); });
      request.on("error", reject); request.end();
    });
    assert.equal(forged, 403);
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }));
    const listed = await client.listTools();
    assert.deepEqual(listed.tools[0]!.inputSchema, schema);
    assert.deepEqual((await client.callTool({ name: "add_beats", arguments: { beats: 4 } })).content, [{ type: "text", text: "4" }]);
    const invalid = await client.callTool({ name: "add_beats", arguments: { beats: -1 } });
    assert.equal(invalid.isError, true); assert.equal(total, 4);
    await revokeMcpServerClient(directory, grant.client.id, grant.client.generation);
    assert.equal((await fetch(server.url, { headers: { Authorization: `Bearer ${grant.token}` } })).status, 401);
  } finally { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
  await assert.rejects(fetch(server.url));
});

test("MCP HTTP reports a bound port conflict", async () => {
  const module = await import("../../../src/app/mcp/server.js").catch(() => undefined);
  assert.equal(typeof module?.createMcpHttpServer, "function");
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
  const address = occupied.address(); assert(address && typeof address === "object");
  try {
    await assert.rejects(module!.createMcpHttpServer({ port: address.port, authenticate: async () => undefined, tools: async () => [], callTool: async () => ({ content: [] }) }), /port|EADDRINUSE/i);
  } finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
});

test("MCP catalog pagination preserves complete schemas and rejects stale cursors", async () => {
  const { createMcpHttpServer } = await import("../../../src/app/mcp/server.js");
  const directory = await mkdtemp(join(tmpdir(), "mcp-pages-"));
  const grant = await createMcpServerClient(directory, { name: "Pages", projectKey: "set", sessionId: "session" });
  const tools = Array.from({ length: 8 }, (_, index) => ({ type: "function" as const, function: {
    name: `tool_${index}`, description: "Full schema fixture",
    parameters: { type: "object", properties: { value: { type: "string", enum: [String(index).repeat(64 * 1024)] } }, required: ["value"] },
  } }));
  const server = await createMcpHttpServer({ port: 0,
    authenticate: token => authenticateMcpServerClient(directory, token), tools: async () => tools,
    callTool: async () => ({ content: [] }),
  });
  const client = new Client({ name: "pagination", version: "1" }, { versionNegotiation: { mode: "auto" } });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { Authorization: `Bearer ${grant.token}` } } }));
    const first = await client.request({ method: "tools/list" });
    assert(first.nextCursor); assert(first.tools.length < tools.length);
    const collected = [...first.tools];
    let cursor: string | undefined = first.nextCursor;
    while (cursor) {
      const page = await client.listTools({ cursor }); collected.push(...page.tools); cursor = page.nextCursor;
    }
    assert.deepEqual(collected.map(tool => tool.inputSchema), tools.map(tool => tool.function.parameters));
    assert.deepEqual(collected.map(tool => tool.name), tools.map(tool => tool.function.name));
    tools[0]!.function.description = "Updated catalog";
    await assert.rejects(client.listTools({ cursor: first.nextCursor }), /catalog changed|cursor is invalid/i);
  } finally { await client.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
