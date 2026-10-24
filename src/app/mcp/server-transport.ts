import "../../runtime/mcp-web-constructors.js";
import { createServer, type IncomingMessage } from "node:http";
import { URL } from "node:url";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createMcpHandler, fromJsonSchema, McpServer, ResourceTemplate, type AuthInfo, type JsonSchemaType } from "@modelcontextprotocol/server";
import { localhostHostValidation, localhostOriginValidation, toNodeHandler, type NodeIncomingMessageLike } from "@modelcontextprotocol/node";
import type { McpServerClient } from "../../storage/mcp-server-auth.js";
import { combineHostAbortSignals, createHostAbortController } from "../../runtime/host.js";

import type { McpHttpServerOptions } from "./server.js";

export async function createMcpTransportServer(options: McpHttpServerOptions): Promise<{ url: string; notifyToolsChanged(): void; close(): Promise<void> }> {
  const shutdown = createHostAbortController();
  const handler = createMcpHandler(async ({ authInfo }) => {
    const client = authInfo?.extra?.client as McpServerClient | undefined;
    if (!client) throw new Error("MCP client authorization is required.");
    const server = new McpServer({ name: "live-smith", version: "0.3.0" });
    server.server.registerCapabilities({ tools: { listChanged: true } });
    server.server.setRequestHandler("tools/list", async request => {
      const tools = (await options.tools(client)).map(tool => ({ name: tool.function.name, description: tool.function.description,
        inputSchema: tool.function.parameters as { type: "object"; [key: string]: unknown } }));
      const digest = createHash("sha256").update(JSON.stringify(tools)).digest("hex");
      const cursor = request.params?.cursor;
      const match = cursor === undefined ? undefined : /^([a-f0-9]{64}):(\d+)$/u.exec(cursor);
      const offset = match ? Number(match[2]) : 0;
      if (cursor !== undefined && (!match || match[1] !== digest || !Number.isSafeInteger(offset) || offset >= tools.length)) throw new Error("Tool catalog changed or cursor is invalid. List tools again from the first page.");
      let end = offset, byteLength = 0;
      while (end < tools.length) {
        const bytes = Buffer.byteLength(JSON.stringify(tools[end]));
        if (end > offset && byteLength + bytes > 256 * 1024) break;
        byteLength += bytes; end++;
      }
      return { tools: tools.slice(offset, end), ...(end < tools.length ? { nextCursor: `${digest}:${end}` } : {}) };
    });
    server.server.setRequestHandler("tools/call", async (request, context) => {
      const tool = options.controlTools?.find(tool => tool.function.name === request.params.name) ??
        (await options.tools(client)).find(tool => tool.function.name === request.params.name);
      if (!tool) return { content: [{ type: "text", text: "This tool is unavailable. Refresh the tool catalog." }], isError: true };
      const schema = fromJsonSchema<Record<string, unknown>>(tool.function.parameters as JsonSchemaType);
      const parsed = await schema["~standard"].validate(request.params.arguments ?? {});
      if (parsed.issues) return { content: [{ type: "text", text: "Tool arguments do not match the declared schema." }], isError: true };
      const result = await options.callTool(client, tool.function.name, parsed.value,
        combineHostAbortSignals([shutdown.signal, context.mcpReq.signal]));
      return server.server.projectCallToolResult(result, undefined);
    });
    if (options.listResources && options.readResource) {
      server.registerResource("session-artifacts", new ResourceTemplate("livesmith://sessions/{sessionId}/artifacts/{kind}/{id}", {
        list: context => options.listResources!(client, combineHostAbortSignals([shutdown.signal, context.mcpReq.signal])),
      }), { description: "Artifacts and attachments belonging to the authorized Live Smith Session." },
      (uri, _variables, context) => options.readResource!(client, uri.href, combineHostAbortSignals([shutdown.signal, context.mcpReq.signal])));
    }
    return server;
  }, { maxRequestBodySize: 4 * 1024 * 1024, ...(options.onError ? { onerror: options.onError } : {}) });
  const serve = toNodeHandler(handler, { maxRequestBodySize: 4 * 1024 * 1024, ...(options.onError ? { onerror: options.onError } : {}) });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    try {
      const header = request.headers.authorization;
      const match = typeof header === "string" ? /^Bearer ([A-Za-z0-9_.-]+)$/u.exec(header) : undefined;
      const client = match ? await options.authenticate(match[1]!) : undefined;
      if (!client) {
        response.writeHead(401, { "WWW-Authenticate": 'Bearer realm="Live Smith"' }); response.end("MCP client authorization is required."); return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (await options.handleFileRequest?.(client, request, response, shutdown.signal)) return;
      if (url.pathname !== "/mcp" || url.search) { response.writeHead(404); response.end(); return; }
      const authorized = request as IncomingMessage & { auth: AuthInfo };
      authorized.auth = { token: "", clientId: client.id, scopes: ["session:tools"], extra: { client } };
      await serve(authorized as NodeIncomingMessageLike, response);
    } catch {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Live Smith could not serve this MCP request." }));
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
  } catch {
    shutdown.abort(); await handler.close();
    throw new Error(`Live Smith MCP could not listen on port ${options.port}. Choose an available port.`);
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Live Smith MCP listener is unavailable.");
  let closePromise: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    notifyToolsChanged() { handler.notify.toolsChanged(); },
    close() {
      return closePromise ??= (async () => {
        shutdown.abort(); await handler.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })();
    },
  };
}
