import { URL } from "node:url";

const endpoints = new Set<string>();
function endpointKey(value: string): string | undefined {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return undefined;
  return `${url.port || "80"}${url.pathname.replace(/\/$/u, "")}`;
}
export function registerLocalMcpEndpoint(url: string): () => void {
  const key = endpointKey(url)!;
  endpoints.add(key);
  return () => { endpoints.delete(key); };
}
export function assertExternalMcpEndpoint(url: string): void {
  const key = endpointKey(url);
  if (key && endpoints.has(key)) throw new Error("This MCP connection points to Live Smith's own outward service. Choose an external server.");
}
