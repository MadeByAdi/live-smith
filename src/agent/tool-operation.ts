import { isArtifactRefs, type ArtifactRef } from "./artifact-contracts.js";
import { isMcpToolActor, type ToolActor } from "./tool-actor.js";
import { formatUiMessage, isUiMessage, type UiMessage } from "../i18n/ui-message.js";

export type ExternalToolActor = Extract<ToolActor, { kind: "mcp" }>;
export type ToolOperationStatus = "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "interrupted";
export interface ToolOperationOutput {
  content: string;
  failed: boolean;
  cancelled?: boolean;
  outcomeUnknown?: boolean;
  artifacts?: ArtifactRef[];
  audioAttachmentId?: string;
  inputAttachmentIds?: string[];
}
export interface ToolOperationSnapshot {
  id: string;
  actor: ExternalToolActor;
  toolName: string;
  status: ToolOperationStatus;
  progress: UiMessage;
  result?: ToolOperationOutput;
}
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
export function isToolOperationOutput(value: unknown): value is ToolOperationOutput {
  return record(value) && keys(value, ["content", "failed", "cancelled", "outcomeUnknown", "artifacts", "audioAttachmentId", "inputAttachmentIds"]) &&
    typeof value.content === "string" && typeof value.failed === "boolean" &&
    (value.cancelled === undefined || typeof value.cancelled === "boolean") &&
    (value.outcomeUnknown === undefined || typeof value.outcomeUnknown === "boolean") &&
    (value.artifacts === undefined || isArtifactRefs(value.artifacts)) &&
    (value.audioAttachmentId === undefined || id(value.audioAttachmentId)) &&
    (value.inputAttachmentIds === undefined || Array.isArray(value.inputAttachmentIds) && value.inputAttachmentIds.length <= 8 && value.inputAttachmentIds.every(id));
}
export function isToolOperationSnapshot(value: unknown): value is ToolOperationSnapshot {
  return record(value) && keys(value, ["id", "actor", "toolName", "status", "progress", "result"]) &&
    id(value.id) && isMcpToolActor(value.actor) && typeof value.toolName === "string" && value.toolName.length > 0 && value.toolName.length <= 256 &&
    ["running", "awaiting_approval", "completed", "failed", "cancelled", "interrupted"].includes(String(value.status)) &&
    isUiMessage(value.progress) && formatUiMessage(value.progress).length <= 4096 &&
    (value.result === undefined || isToolOperationOutput(value.result));
}
export function toolOperationFinished(status: ToolOperationStatus): boolean {
  return status !== "running" && status !== "awaiting_approval";
}
