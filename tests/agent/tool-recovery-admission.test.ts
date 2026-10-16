import assert from "node:assert/strict";
import test from "node:test";
import { activeRecoveryLedgerFromEvents } from "../../src/app/context/session-context.js";
import { createAgentRecoveryState, executeAgentTool } from "../../src/agent/tool-execution.js";

test("unconfirmed Live writes require fresh observation and explicit reconciliation before replay", async () => {
  const plan = { message: "Create track", actions: [{ type: "create_midi_track" as const, name: "Bass" }] };
  const initial = activeRecoveryLedgerFromEvents([{ id: "proposal", createdAt: "2026-10-16T00:00:00Z", kind: "apply_requested", content: "Create track",
    applyOperation: { id: "interrupted-apply", status: "proposed", plan } }]);
  const recovery = createAgentRecoveryState(initial);
  let writes = 0, approvals = 0;
  const options = { observe: async () => "Current Set includes Bass", preflightActions: async () => async () => undefined,
    confirmActions: async () => true, confirmRecoveryResolution: async () => { approvals++; return true; },
    executeActions: async () => { writes++; return { results: ["Created Bass"], mutationCount: 1 }; } };
  const call = { id: "repeat", name: "apply_live_actions", arguments: JSON.stringify(plan) };
  assert.equal((await executeAgentTool(options, call, recovery)).failed, true);
  assert.equal(writes, 0);
  assert.equal((await executeAgentTool(options, { id: "resolve-too-early", name: "resolve_live_recovery", arguments: "{}" }, recovery)).failed, true);
  assert.equal(approvals, 0);
  await executeAgentTool(options, { id: "inspect", name: "inspect_live_set", arguments: "{}" }, recovery);
  assert.equal((await executeAgentTool(options, call, recovery)).failed, true);
  await executeAgentTool(options, { id: "resolve", name: "resolve_live_recovery", arguments: "{}" }, recovery);
  assert.equal(approvals, 1);
  assert.equal((await executeAgentTool(options, call, recovery)).failed, false);
  assert.equal(writes, 1);
});
