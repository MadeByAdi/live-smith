import assert from "node:assert/strict";
import test from "node:test";
import { createDialogHarness, stateFixture, waitForCondition } from "../support/chat-dialog.test-harness.js";

for (const kind of ["error", "compaction"] as const) {
  test(`${kind} details keep complete diagnostics in a keyboard-accessible region`, async () => {
    const state = stateFixture(); state.openSettingsOnLoad = false;
    const content = "Diagnostic summary\n" + Array.from({ length: 180 }, (_, index) => `Detail ${index}: ${"context ".repeat(8)}`).join("\n");
    state.events = [{ id: "diagnostic", kind, content, createdAt: "2026-10-16T00:00:00Z" }];
    const h = await createDialogHarness(state);
    try {
      const details = h.document.querySelector<HTMLDetailsElement>('[data-event-id="diagnostic"]')!;
      if (!details.open) details.querySelector<HTMLElement>(":scope > summary")!.click();
      const region = details.querySelector<HTMLElement>('[role="region"]');
      assert.ok(region);
      assert.match(region.textContent!, /Detail 179:/);
      region.focus(); assert.equal(h.document.activeElement, region);
      details.querySelector<HTMLElement>(":scope > summary")!.click();
      assert.equal(details.open, false);
      assert.equal(h.readBootstrappedClientStateReference().events[0]!.content, content);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
}

test("Web Search keeps every query and source inside its accessible details region", async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const sources = Array.from({ length: 20 }, (_, index) => ({ title: `Source ${index}`, url: `https://example.test/source-${index}` }));
  const queries = Array.from({ length: 8 }, (_, index) => `Query ${index}: ${"Ableton ".repeat(50)}`.trimEnd());
  state.events = [{ id: "search", kind: "web_search", content: "Search completed", createdAt: "2026-10-16T00:00:00Z",
    webSearch: { id: "search-details", status: "completed", action: "search", queries, sources } }];
  const h = await createDialogHarness(state);
  try {
    h.click('[data-event-id="search"] > summary');
    const region = h.document.querySelector<HTMLElement>('[data-event-id="search"] [role="region"]');
    assert.ok(region);
    region.focus(); assert.equal(h.document.activeElement, region);
    assert.equal(region.querySelectorAll("a").length, 20);
    assert.equal(Array.from(region.querySelectorAll("a")).at(-1)?.getAttribute("href"), sources.at(-1)!.url);
    assert.match(region.textContent!, /Source 19/);
    assert.match(region.textContent!, /Query 7:/);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("streaming reasoning follows its inner tail until the reader scrolls away", async () => {
  const state = stateFixture(); state.openSettingsOnLoad = false;
  const h = await createDialogHarness(state); h.holdNextSend();
  try {
    h.input("#prompt", "Inspect the track"); h.click("#sendButton");
    await waitForCondition(() => h.sendIds.length === 1, "Expected send");
    const emit = (delta: string) => {
      h.emitServerEvent({ type: "reasoning_update", sendId: h.sendIds[0], sessionId: "session-1", modelTurnEpoch: 0, update: { type: "delta", delta } });
      h.flushAnimationFrames();
    };
    emit("Inspecting track. ".repeat(180));
    const body = h.document.querySelector<HTMLElement>('.reasoning.streaming [role="region"]');
    assert.ok(body);
    body.focus(); assert.equal(h.document.activeElement, body);
    let top = 0;
    Object.defineProperties(body, {
      clientHeight: { configurable: true, get: () => 200 },
      scrollHeight: { configurable: true, get: () => body.textContent!.length },
      scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, body.scrollHeight - body.clientHeight)); } },
    });
    body.scrollTop = body.scrollHeight - body.clientHeight;
    emit("The last observation is available.");
    assert.equal(body.scrollTop, body.scrollHeight - body.clientHeight);
    body.scrollTop = 30;
    emit(" More observations arrived.");
    assert.equal(body.scrollTop, 30);
    assert.equal(h.document.activeElement, body);
    assert.match(body.textContent!, /More observations arrived\./);
    assert.deepEqual(h.errors, []);
  } finally { h.releaseHeldSend(); await h.settle(); h.close(); }
});

for (const kind of ["compaction", "reasoning", "web_search"] as const) {
  test(`${kind} retains detail focus and scrolling across unrelated and content updates`, async () => {
    const state = stateFixture(); state.openSettingsOnLoad = false;
    const detail = { id: "saved-detail", kind, content: "Saved diagnostic. ".repeat(180), createdAt: "2026-10-16T00:00:00Z",
      ...(kind === "web_search" ? { webSearch: { id: "saved-search", status: "completed" as const, action: "search" as const,
        queries: ["Ableton"], sources: Array.from({ length: 19 }, (_, index) => ({ url: `https://example.test/source-${index}`, title: `Original source ${index}` })) } } : {}) };
    state.events = [detail];
    const h = await createDialogHarness(state); h.holdNextSend();
    try {
      h.input("#prompt", "Continue inspecting"); h.click("#sendButton");
      await waitForCondition(() => h.sendIds.length === 1, "Expected send");
      h.click('[data-event-id="saved-detail"] > summary');
      const body = h.document.querySelector<HTMLElement>('[data-event-id="saved-detail"] [role="region"]')!;
      body.scrollTop = 120; body.focus();
      h.emitServerEvent({ type: "session_event", sendId: h.sendIds[0], sessionId: "session-1", event: {
        id: "next-call", kind: "tool_call", name: "inspect_song_info", content: "{}", createdAt: "2026-10-16T00:00:01Z",
      } });
      assert.equal(h.document.querySelector('[data-event-id="saved-detail"] [role="region"]'), body);
      assert.equal(body.scrollTop, 120);
      assert.equal(h.document.activeElement, body);
      h.emitServerEvent({ type: "session_event", sendId: h.sendIds[0], sessionId: "session-1", event: { ...detail,
        content: detail.content + " Updated detail.", ...(detail.webSearch ? { webSearch: { ...detail.webSearch,
          sources: [...detail.webSearch.sources, { url: "https://example.test/updated", title: "Updated source" }] } } : {}),
      } });
      assert.equal(h.document.querySelector('[data-event-id="saved-detail"] [role="region"]'), body);
      assert.equal(body.scrollTop, 120);
      assert.equal(h.document.activeElement, body);
      assert.match(body.textContent!, /Updated/);
      assert.deepEqual(h.errors, []);
    } finally { h.releaseHeldSend(); await h.settle(); h.close(); }
  });
}
