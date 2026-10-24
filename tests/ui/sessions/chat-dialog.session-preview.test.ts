import assert from "node:assert/strict";
import test from "node:test";
import { commandCalls, createDialogHarness, stateFixture } from "../support/chat-dialog.test-harness.js";

test("History click shows escaped read-only preview while active Session and Continue remain separate", async () => {
  const state = stateFixture();
  state.sessionContinueTarget = { kind: "object", label: "Live Set" };
  state.previousSessions = [{ ...state.sessions[0]!, id: "prior-session", projectKey: "prior-project",
    title: "Past <Set>", scope: { kind: "track", identity: "old-track", label: "Lead" } }];
  const harness = await createDialogHarness(state, undefined, { sessionPreviewResponse: (input) => ({
    ...input, title: "Past <Set>", total: 1, artifactCount: 1,
    artifacts: [{ kind: "audio", id: "old-audio" }],
    messages: [{ id: "old-event", kind: "assistant", createdAt: "2026-10-12T00:00:00.000Z",
      content: "<img src=x onerror=alert(1)> saved answer", truncated: false, artifacts: [] }],
  }) });
  try {
    harness.click('.session-entry[data-session-id="prior-session"] .session-row');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const panel = harness.document.getElementById("sessionHistoryPreview")!;
    assert.equal(panel.hidden, false);
    assert.equal(harness.document.getElementById("timeline")?.hidden, true);
    assert.match(panel.textContent ?? "", /Read-only history/);
    assert.match(panel.textContent ?? "", /<img src=x onerror=alert\(1\)> saved answer/);
    assert.equal(panel.querySelector("img"), null);
    assert.equal(harness.document.querySelector('[data-continue-session-id="prior-session"]'), null);
    assert.equal(harness.document.querySelector('.session-entry[data-session-id="session-1"] .session-row')?.getAttribute("aria-pressed"), "true");
    assert.deepEqual(commandCalls(harness), []);
    harness.click("#sessionHistoryPreviewClose");
    assert.equal(panel.hidden, true);
    assert.equal(harness.document.getElementById("timeline")?.hidden, false);
    assert.deepEqual(commandCalls(harness), []);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});

test("compatible real context keeps explicit Continue after opening History preview", async () => {
  const state = stateFixture();
  state.sessionContinueTarget = { kind: "track", label: "Current Lead" };
  state.previousSessions = [{ ...state.sessions[0]!, id: "prior-session", projectKey: "prior-project",
    scope: { kind: "track", identity: "old-track", label: "Old Lead" } }];
  const harness = await createDialogHarness(state);
  try {
    harness.click('.session-entry[data-session-id="prior-session"] .session-row');
    assert.deepEqual(commandCalls(harness), []);
    harness.click('[data-continue-session-id="prior-session"]');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(commandCalls(harness).map((call) => call.body), [
      { kind: "restore_session", sessionId: "prior-session" },
    ]);
    assert.equal(harness.document.getElementById("sessionHistoryPreview")?.hidden, true);
    assert.deepEqual(harness.errors, []);
  } finally { harness.close(); }
});
