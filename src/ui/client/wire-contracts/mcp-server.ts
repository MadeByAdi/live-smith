import { isAgentActionPreviews } from "../../../agent/action-preview.js";
import { validateAgentPlan } from "../../../agent/actions.js";
import { isMcpToolActor } from "../../../agent/tool-actor.js";
import { isToolOperationSnapshot } from "../../../agent/tool-operation.js";
import { isUiMessage } from "../../../i18n/ui-message.js";
import { normalizeMcpServerSettings } from "../../../model/mcp-server.js";
import { hasOnlyWireKeys, isWireRecord, isWireStorageId } from "./primitives.js";

export function isWireMcpServerSettings(value: unknown): boolean {
  if (value === undefined) return false;
  try { normalizeMcpServerSettings(value); return true; } catch { return false; }
}
export function isWireMcpService(value: unknown): boolean {
  return isWireRecord(value) && hasOnlyWireKeys(value, ["settings", "status", "url", "error", "clients"]) &&
    isWireMcpServerSettings(value.settings) && ["running", "disabled", "error"].includes(String(value.status)) &&
    typeof value.url === "string" && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u.test(value.url) &&
    (value.error === undefined || typeof value.error === "string") &&
    Array.isArray(value.clients) && value.clients.length <= 64 && value.clients.every(client => isWireRecord(client) &&
      hasOnlyWireKeys(client, ["id", "name", "projectKey", "sessionId", "generation", "createdAt"]) &&
      isWireStorageId(client.id) && isWireStorageId(client.sessionId) && isWireStorageId(client.generation) &&
      typeof client.name === "string" && client.name.length <= 120 && typeof client.projectKey === "string" && typeof client.createdAt === "string");
}
export function isWireMcpCredential(value: unknown): boolean {
  return isWireRecord(value) && hasOnlyWireKeys(value, ["clientId", "token", "url"]) && isWireStorageId(value.clientId) &&
    typeof value.token === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(value.token) &&
    typeof value.url === "string" && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u.test(value.url);
}
export function isWireMcpOperations(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 20 && value.every(isToolOperationSnapshot);
}
export function isWireMcpApprovals(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 64 && value.every(entry => {
    if (!isWireRecord(entry) || !hasOnlyWireKeys(entry, ["operationId", "actor", "request"]) ||
      !isWireStorageId(entry.operationId) || !isMcpToolActor(entry.actor) || !isWireRecord(entry.request)) return false;
    const request = entry.request;
    if (!hasOnlyWireKeys(request, ["kind", "message", "groups", "previews", "operationId", "plan"]) ||
      !["apply", "resolve_recovery"].includes(String(request.kind)) || typeof request.message !== "string" ||
      !Array.isArray(request.groups) || !request.groups.every(group => isWireRecord(group) &&
        hasOnlyWireKeys(group, ["title", "rows"]) && isUiMessage(group.title) && Array.isArray(group.rows) && group.rows.every(row => isUiMessage(row))) ||
      request.previews !== undefined && !isAgentActionPreviews(request.previews) ||
      request.operationId !== undefined && !isWireStorageId(request.operationId)) return false;
    if (request.plan !== undefined) { try { validateAgentPlan(request.plan); } catch { return false; } }
    return true;
  });
}
