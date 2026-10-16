import assert from "node:assert/strict";
import test from "node:test";

test("single tool execution validates, confirms and applies without a model turn", async () => {
  const module = await import("../../src/agent/tool-execution.js").catch(() => undefined);
  assert.equal(typeof module?.executeAgentTool, "function");
  let tempo = 120;
  const events: string[] = [];
  const options = {
    observe: async () => JSON.stringify({ tempo }),
    preflightActions: async () => async () => undefined,
    confirmActions: async () => ({ confirmed: true as const, source: "automatic" as const, mode: "everything" as const }),
    executeActions: async (plan: { actions: Array<{ type: string; tempo?: number }> }) => {
      tempo = plan.actions[0]!.tempo!;
      return { results: [`Tempo set to ${tempo}`], mutationCount: 1 };
    },
    onEvent: async (event: { kind: string }) => { events.push(event.kind); },
  };
  const recovery = module!.createAgentRecoveryState();
  const result = await module!.executeAgentTool(options, { id: "call", name: "apply_live_actions", arguments: JSON.stringify({ message: "Change tempo", actions: [{ type: "set_tempo", tempo: 128 }] }) }, recovery);
  assert.equal(result.failed, false);
  assert.equal(tempo, 128);
  assert(events.includes("apply_auto_approved"));
  assert.equal(events.filter(kind => kind === "tool_call").length, 1);
  const rejected = await module!.executeAgentTool({ ...options, admittedToolNames: ["inspect_live_set"] }, { id: "forbidden", name: "apply_live_actions", arguments: JSON.stringify({ message: "Change tempo", actions: [{ type: "set_tempo", tempo: 90 }] }) }, recovery);
  assert.equal(rejected.failed, true);
  assert.equal(tempo, 128);
});
