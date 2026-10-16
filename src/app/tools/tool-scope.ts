import { EditScopeDeniedError, resolveEditScopes, type EditScope } from "../../agent/edit-scopes.js";
import { throwIfAborted } from "../../runtime/host.js";
import { withStorageTransaction } from "../../storage/persistence.js";
import { listSessionsInTransaction, type AgentSession } from "../../storage/sessions.js";
import { subscribeSessionEditScopesChanges, subscribeSessionEditScopesInvalidations } from "../session/session-edit-scope-events.js";

export function createToolScope(input: { storageDirectory: string | undefined; projectKey: string; session: AgentSession; signal: AbortSignal }) {
  const { storageDirectory, projectKey, session, signal } = input;
  let unsubscribeEditScopes: (() => void) | undefined;
  let unsubscribeEditScopesInvalidations: (() => void) | undefined;
  let activeEditScopes: EditScope[] | undefined = resolveEditScopes(session.editScopes);
  let editScopesGeneration = 0;
  const currentEditScopes = () => {
    if (!activeEditScopes) throw new EditScopeDeniedError([]);
    return activeEditScopes;
  };
  const readEditScopes = async () => {
    const generation = editScopesGeneration;
    const current = await withStorageTransaction(
      storageDirectory,
      async (transaction) => (await listSessionsInTransaction(
        transaction, storageDirectory, projectKey,
      )).find((candidate) => candidate.id === session.id && !candidate.archivedAt),
    );
    if (!current) throw new Error("That Session is not available in this Live Set.");
    throwIfAborted(signal);
    if (generation === editScopesGeneration) {
      activeEditScopes = resolveEditScopes(current.editScopes);
    }
    return [...currentEditScopes()];
  };
  return { readEditScopes, currentEditScopes,
    subscribe() {
    // Committed changes update the synchronous action boundary without inserting
    // a disk await after the final Live-state drift check.
    unsubscribeEditScopes = subscribeSessionEditScopesChanges(
      storageDirectory,
      (change) => {
        if (change.sessionId !== session.id) return;
        editScopesGeneration += 1;
        activeEditScopes = resolveEditScopes(change.editScopes);
      },
    );
    unsubscribeEditScopesInvalidations = subscribeSessionEditScopesInvalidations(
      storageDirectory,
      (changedSessionId) => {
        if (changedSessionId !== session.id) return;
        editScopesGeneration += 1;
        activeEditScopes = undefined;
      },
    );
    },
    close() { unsubscribeEditScopes?.(); unsubscribeEditScopesInvalidations?.(); },
  };
}
