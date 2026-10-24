import assert from "node:assert/strict";
import test from "node:test";
import { createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";

function toolEvent(id: string, kind: "tool_call" | "tool_result", content: string) {
  return { id, kind, name: "inspect_device", content, createdAt: "2026-10-16T00:00:00.000Z",
    ...(kind === "tool_result" ? { outcome: "success" as const } : {}) };
}

test("tool cards show the complete result before collapsed input parameters", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const input = JSON.stringify({ values: Array.from({ length: 128 }, (_, index) => ({ index, value: index / 128 })) });
  const output = Array.from({ length: 128 }, (_, index) => `Parameter ${index}: current=${index / 128}`).join("\n");
  state.events = [toolEvent("call", "tool_call", input), toolEvent("result", "tool_result", output)];
  const harness = await createDialogHarness(state);
  try {
    harness.click('[data-activity-step-id="call"] > summary');
    const parameters = harness.document.querySelector<HTMLDetailsElement>('details[data-event-id="call"]');
    const result = harness.document.querySelector<HTMLElement>('[data-event-id="result"] .timeline-activity-detail-content')!;
    assert.ok(parameters, "Input parameters must have their own disclosure");
    assert.equal(parameters.open, false);
    assert.equal(result.textContent, output, "Long results must retain their last line");
    assert.equal(result.closest<HTMLDetailsElement>("details")?.open, true);
    assert.ok(result.compareDocumentPosition(parameters) & harness.window.Node.DOCUMENT_POSITION_FOLLOWING);
    result.focus();
    assert.equal(harness.document.activeElement, result, "Keyboard users can focus the result scroll region");
    harness.click('[data-event-id="call"] > summary');
    assert.equal(parameters.open, true);
    const inputBody = parameters.querySelector<HTMLElement>(".timeline-activity-detail-content")!;
    assert.equal(inputBody.textContent, input, "Single-line JSON must remain complete");
    inputBody.focus();
    assert.equal(harness.document.activeElement, inputBody);
    harness.click('[data-event-id="call"] > summary');
    assert.equal(parameters.open, false);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("an arriving result preserves input disclosure, keyboard focus and scroll position", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  const call = toolEvent("call", "tool_call", "Device input\n".repeat(100));
  state.events = [call];
  const harness = await createDialogHarness(state);
  try {
    harness.holdNextSend();
    harness.input("#prompt", "Inspect the device");
    harness.click("#sendButton");
    await harness.settle();
    harness.click('[data-activity-step-id="call"] > summary');
    const parameters = harness.document.querySelector<HTMLDetailsElement>('details[data-event-id="call"]');
    assert.ok(parameters);
    harness.click('[data-event-id="call"] > summary');
    const summary = parameters.querySelector<HTMLElement>(":scope > summary")!;
    const body = parameters.querySelector<HTMLElement>(".timeline-activity-detail-content")!;
    body.scrollTop = 96;
    summary.focus();
    const result = toolEvent("result", "tool_result", "Observed parameters\n".repeat(100));
    harness.emitServerEvent({ type: "session_event", sendId: harness.sendIds[0], sessionId: state.activeSessionId, event: result });
    assert.equal(harness.document.querySelector('[data-event-id="call"]'), parameters);
    assert.equal(parameters.open, true);
    assert.equal(body.scrollTop, 96);
    assert.equal(harness.document.activeElement, summary);
    harness.click('[data-event-id="call"] > summary');
    harness.emitServerEvent({ type: "session_event", sendId: harness.sendIds[0], sessionId: state.activeSessionId,
      event: { ...result, content: "Updated observation" } });
    assert.equal(parameters.open, false, "Later updates must preserve a user close");
    assert.equal(harness.document.querySelector('[data-event-id="result"] .timeline-activity-detail-content')?.textContent, "Updated observation");
    assert.deepEqual(harness.errors, []);
  } finally { harness.releaseHeldSend(); await harness.settle(); harness.close(); }
});

test("input disclosure and original payload survive a language change", async () => {
  const state = stateFixture();
  state.openSettingsOnLoad = false;
  state.settings.uiLanguage = "en";
  const input = '{"deviceName":"Original device"}';
  state.events = [toolEvent("call", "tool_call", input), toolEvent("result", "tool_result", "Original result")];
  const harness = await createDialogHarness(state);
  try {
    harness.click('[data-activity-step-id="call"] > summary');
    const parameters = harness.document.querySelector<HTMLDetailsElement>('details[data-event-id="call"]');
    assert.ok(parameters);
    harness.click('[data-event-id="call"] > summary');
    const summary = parameters.querySelector<HTMLElement>(":scope > summary")!;
    summary.focus();
    harness.emitServerEvent({ type: "global_settings_changed",
      defaultFollowUpBehavior: state.settings.defaultFollowUpBehavior,
      defaultFollowUpBehaviorRevision: state.settings.defaultFollowUpBehaviorRevision,
      showContextUsage: state.settings.showContextUsage,
      contextUsageVisibilityRevision: state.settings.contextUsageVisibilityRevision,
      uiLanguage: "zh-CN", uiLanguageRevision: "1", commandId: "language-external" });
    await harness.settle();
    assert.equal(harness.document.documentElement.lang, "zh-CN");
    assert.equal(parameters.open, true);
    assert.equal(summary.textContent, "输入参数");
    assert.equal(parameters.querySelector(".timeline-activity-detail-content")?.textContent, input);
    assert.equal(harness.document.activeElement, summary);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
