import { requiresExplicitConfirmation, type AgentPlan } from "../../agent/actions.js";
import type { AgentConfirmationDecision } from "../../agent/tool-execution.js";
import { withStorageTransaction } from "../../storage/persistence.js";
import { listSessionsInTransaction } from "../../storage/sessions.js";

export async function decidePlanApproval(
  storageDirectory: string | undefined,
  sessionId: string,
  plan: AgentPlan,
  requestConfirmation: () => Promise<boolean>,
): Promise<AgentConfirmationDecision> {
  const approvalMode = await withStorageTransaction(
    storageDirectory,
    async (transaction) => {
      const session = (await listSessionsInTransaction(
        transaction,
        storageDirectory,
      )).find((candidate) => candidate.id === sessionId);
      if (!session) throw new Error(`Session ${sessionId} does not exist.`);
      return session.approvalMode ?? "manual";
    },
  );
  if (
    approvalMode === "everything" ||
    (approvalMode === "low-risk" && !requiresExplicitConfirmation(plan))
  ) {
    return {
      confirmed: true,
      source: "automatic",
      mode: approvalMode,
    };
  }
  return {
    confirmed: await requestConfirmation(),
    source: "user",
  };
}
