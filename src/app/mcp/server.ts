import type { IncomingMessage, ServerResponse } from "node:http";
import type { CallToolResult, ListResourcesResult, ReadResourceResult } from "@modelcontextprotocol/server";
import type { ModelFunctionTool } from "../../model/provider.js";
import type { McpServerClient } from "../../storage/mcp-server-auth.js";

export interface McpHttpServerOptions {
  port: number;
  onError?(error: Error): void;
  /** Local control tools remain available while business tool discovery is busy. */
  controlTools?: readonly ModelFunctionTool[];
  listResources?(client: McpServerClient, signal: AbortSignal): Promise<ListResourcesResult>;
  readResource?(client: McpServerClient, uri: string, signal: AbortSignal): Promise<ReadResourceResult>;
  handleFileRequest?(client: McpServerClient, request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<boolean>;

  authenticate(token: string): Promise<McpServerClient | undefined>;
  tools(client: McpServerClient): Promise<readonly ModelFunctionTool[]>;
  callTool(client: McpServerClient, name: string, argumentsValue: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
}

/** Load transport dependencies after the Extension has supplied its host APIs. */
export async function createMcpHttpServer(options: McpHttpServerOptions): Promise<{ url: string; notifyToolsChanged(): void; close(): Promise<void> }> {
  const { createMcpTransportServer } = await import("./server-transport.js");
  return createMcpTransportServer(options);
}
