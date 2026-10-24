import { isArtifactRef } from "../../agent/artifact-contracts.js";
import { throwIfAborted } from "../../runtime/host.js";
import { loadSessionEvents } from "../../storage/events.js";
import { isSafeStorageId } from "../../storage/id.js";
import { listPersistedSessions } from "../../storage/sessions.js";

import { MAX_SESSION_PREVIEW_MESSAGE_LENGTH, SESSION_PREVIEW_PAGE_SIZE,
  type SessionPreview, type SessionPreviewInput } from "./session-preview-contracts.js";

/** A bounded projection of persisted history, with no Live target or Session mutation. */
export async function readSessionPreview(input: SessionPreviewInput & {
  storageDirectory: string | undefined;
  projectKey: string;
  signal: AbortSignal;
}): Promise<SessionPreview> {
  throwIfAborted(input.signal);
  if (!isSafeStorageId(input.sessionId) || !Number.isSafeInteger(input.offset) || input.offset < 0) {
    throw new Error("Choose a historical Session and preview page.");
  }
  if (!input.storageDirectory) throw new Error("Saved Session history is unavailable.");
  const session = (await listPersistedSessions(input.storageDirectory)).find((entry) =>
    entry.id === input.sessionId && entry.projectKey !== input.projectKey && !entry.archivedAt);
  if (!session) throw new Error("That historical Session is unavailable.");
  const events = await loadSessionEvents(input.storageDirectory, input.sessionId);
  throwIfAborted(input.signal);
  const messages = events.filter((event) => event.kind === "user" || event.kind === "assistant");
  const artifacts = [...new Map(events.flatMap((event) => event.artifacts ?? [])
    .filter(isArtifactRef).map((artifact) => [`${artifact.kind}:${artifact.id}`, artifact] as const)).values()];
  // Recheck membership after disk I/O; a concurrent restore, archive, or deletion must fail closed.
  const stillHistorical = (await listPersistedSessions(input.storageDirectory)).some((entry) =>
    entry.id === input.sessionId && entry.projectKey !== input.projectKey && !entry.archivedAt);
  throwIfAborted(input.signal);
  if (!stillHistorical) throw new Error("That historical Session is unavailable.");
  return {
    sessionId: input.sessionId,
    offset: input.offset,
    title: (session.title || session.scope.label).slice(0, 256),
    total: messages.length,
    artifactCount: artifacts.length,
    artifacts: artifacts.slice(0, 50).map((artifact) => ({ ...artifact })),
    messages: messages.slice(input.offset, input.offset + SESSION_PREVIEW_PAGE_SIZE).map((event) => ({
      id: event.id,
      kind: event.kind as "user" | "assistant",
      createdAt: event.createdAt,
      content: event.content.slice(0, MAX_SESSION_PREVIEW_MESSAGE_LENGTH),
      truncated: event.content.length > MAX_SESSION_PREVIEW_MESSAGE_LENGTH,
      artifacts: (event.artifacts ?? []).filter(isArtifactRef).map((artifact) => ({ ...artifact })),
    })),
  };
}
