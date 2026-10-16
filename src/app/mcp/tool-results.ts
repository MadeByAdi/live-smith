import type { CallToolResult } from "@modelcontextprotocol/server";
import { isCallToolResult } from "@modelcontextprotocol/client";
import { toolOperationFinished, type ToolOperationSnapshot } from "../../agent/tool-operation.js";
import type { ModelFunctionTool } from "../../model/provider.js";
import { mcpResourceUri } from "./resources.js";
import { formatUiMessage } from "../../i18n/ui-message.js";

export const mcpHelperTools: ModelFunctionTool[] = [
  { type: "function", function: { name: "livesmith_get_context", description: "Read the bound Session, current Edit Scope, approval policy and file interfaces. Refresh before planning writes.", parameters: { type: "object", properties: {}, additionalProperties: false } } },
  { type: "function", function: { name: "livesmith_get_operation", description: "Read a previously accepted operation; omit operationId for the latest 20. Query after reconnecting before submitting a write again.", parameters: { type: "object", properties: { operationId: { type: "string", minLength: 1 } }, additionalProperties: false } } },
  { type: "function", function: { name: "livesmith_cancel_operation", description: "Cancel remaining work in an accepted operation. Completed Live changes and submitted remote jobs retain their recorded outcome.", parameters: { type: "object", properties: { operationId: { type: "string", minLength: 1 } }, required: ["operationId"], additionalProperties: false } } },
];

export function jsonMcpResult(value: unknown): CallToolResult {
  const structuredContent = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { result: value };
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent };
}

export function mcpOperationResult(snapshot: ToolOperationSnapshot, sessionId: string): CallToolResult {
  if (!toolOperationFinished(snapshot.status) || !snapshot.result) return jsonMcpResult(mcpOperationSnapshot(snapshot));
  const result = snapshot.result;
  const resources = [...(result.artifacts ?? []).map(artifact => ({ type: "resource_link" as const, name: `${artifact.kind} ${artifact.id}`, uri: mcpResourceUri(sessionId, artifact.kind, artifact.id) })),
    ...(result.audioAttachmentId ? [{ type: "resource_link" as const, name: "Audio result", uri: mcpResourceUri(sessionId, "attachment", result.audioAttachmentId) }] : [])];
  let structuredResult: unknown;
  try { structuredResult = JSON.parse(result.content); } catch { structuredResult = result.content; }
  const content = isCallToolResult(structuredResult) ? structuredResult.content : [{ type: "text" as const, text: result.content }];
  return { content: [...content, ...resources], structuredContent: { operationId: snapshot.id, status: snapshot.status,
    result: structuredResult, ...(result.outcomeUnknown ? { outcomeUnknown: true } : {}) }, ...(result.failed ? { isError: true } : {}) };
}

export function mcpOperationSnapshot(snapshot: ToolOperationSnapshot) {
  return { ...snapshot, progress: formatUiMessage(snapshot.progress) };
}
