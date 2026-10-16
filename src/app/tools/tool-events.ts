import type { ArtifactRef } from "../../agent/artifact-contracts.js";
import type { AgentLoopTraceEvent } from "../../agent/tool-execution.js";
import { appendSessionEvent, type SessionEvent } from "../../storage/events.js";

export async function appendAgentLoopTraceEvent(
  storageDirectory: string | undefined,
  sessionId: string,
  event: AgentLoopTraceEvent,
  appendEvent: typeof appendSessionEvent = appendSessionEvent,
  parentCandidate?: ArtifactRef,
  requestEventId?: string,
): Promise<SessionEvent> {
  if ("name" in event) {
    return appendEvent(storageDirectory, sessionId, {
      kind: event.kind,
      name: event.name,
      content: event.content,
      ...(event.kind === "tool_result" ? { outcome: event.outcome } : {}),
      ...(event.kind === "tool_result" && event.artifacts ? { artifacts: event.artifacts } : {}),
      ...(event.kind === "tool_call" && parentCandidate ? { parentCandidate,
        ...(requestEventId ? { requestEventId } : {}) } : {}),
    });
  }

  return appendEvent(storageDirectory, sessionId, {
    kind: event.kind,
    content: event.content,
    ...("applyOperation" in event && event.applyOperation ? { applyOperation: event.applyOperation } : {}),
    ...(event.kind === "web_search" ? { webSearch: event.webSearch } : {}),
    ...(event.kind === "assistant" && event.citations?.length
      ? { citations: event.citations }
      : {}),
    ...(event.kind === "apply_result" && event.recovery
      ? { recovery: event.recovery }
      : {}),
  });
}
