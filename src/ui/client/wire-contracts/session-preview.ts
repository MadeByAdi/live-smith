import { MAX_SESSION_PREVIEW_MESSAGE_LENGTH, SESSION_PREVIEW_PAGE_SIZE,
  type SessionPreview, type SessionPreviewInput } from "../../../app/session/session-preview-contracts.js";
import { hasOnlyWireKeys, isSafeInteger, isWireRecord, isWireStorageId } from "./primitives.js";

export function isWireSessionPreview(value: unknown, input: SessionPreviewInput): value is SessionPreview {
  if (!isWireRecord(value) || !hasOnlyWireKeys<SessionPreview>(value,
    ["sessionId", "offset", "title", "total", "messages", "artifacts", "artifactCount"]) ||
    value.sessionId !== input.sessionId || value.offset !== input.offset ||
    typeof value.title !== "string" || value.title.length > 256 ||
    !isSafeInteger(value.total) || value.total < 0 ||
    !isSafeInteger(value.artifactCount) || value.artifactCount < 0 ||
    !Array.isArray(value.artifacts) || value.artifacts.length !== Math.min(50, value.artifactCount) ||
    !value.artifacts.every((artifact) => isWireRecord(artifact) &&
      hasOnlyWireKeys(artifact, ["kind", "id"]) &&
      (artifact.kind === "audio" || artifact.kind === "midi" || artifact.kind === "device-parameters") &&
      isWireStorageId(artifact.id)) || !Array.isArray(value.messages) ||
    value.messages.length !== Math.min(SESSION_PREVIEW_PAGE_SIZE, Math.max(0, value.total - input.offset))) return false;
  return value.messages.every((entry) => isWireRecord(entry) &&
    hasOnlyWireKeys<SessionPreview["messages"][number]>(entry,
      ["id", "kind", "createdAt", "content", "truncated", "artifacts"]) &&
    isWireStorageId(entry.id) && (entry.kind === "user" || entry.kind === "assistant") &&
    typeof entry.createdAt === "string" && entry.createdAt.length <= 64 &&
    typeof entry.content === "string" && entry.content.length <= MAX_SESSION_PREVIEW_MESSAGE_LENGTH &&
    typeof entry.truncated === "boolean" && Array.isArray(entry.artifacts) && entry.artifacts.length <= 64 &&
    entry.artifacts.every((artifact) => isWireRecord(artifact) &&
      hasOnlyWireKeys(artifact, ["kind", "id"]) &&
      (artifact.kind === "audio" || artifact.kind === "midi" || artifact.kind === "device-parameters") &&
      isWireStorageId(artifact.id)));
}
