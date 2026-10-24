import assert from "node:assert/strict";
import test from "node:test";
import { URL } from "node:url";
import { createChatBridge } from "../../../../src/app/chat/chat-bridge.js";
import type { ChatDialogState } from "../../../../src/ui/chat-state.js";

test("historical preview requires bridge authentication and exact read-only input", async () => {
  const calls: unknown[] = [];
  const bridge = await createChatBridge({ buildState: async () => ({} as ChatDialogState), renderHtml: () => "",
    handleCommand: async () => assert.fail("Preview must not mutate Sessions"),
    handleSend: async () => assert.fail("Preview must not send"),
    readSessionPreview: async (input) => { calls.push(input); return {
      ...input, title: "Past", messages: [], total: 0, artifacts: [], artifactCount: 0,
    }; },
  });
  const endpoint = new URL(bridge.url); endpoint.pathname = "/session-preview";
  const post = (body: unknown, url = endpoint) => fetch(url, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    const unauthenticated = new URL(endpoint); unauthenticated.search = "";
    assert.equal((await post({ sessionId: "prior-session", offset: 0 }, unauthenticated)).status, 403);
    for (const body of [null, {}, { sessionId: "bad/id", offset: 0 },
      { sessionId: "prior-session", offset: -1 },
      { sessionId: "prior-session", offset: 0, projectKey: "prior-project" }]) {
      assert.equal((await post(body)).status, 400);
    }
    assert.deepEqual(calls, []);
    const response = await post({ sessionId: "prior-session", offset: 0 });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.deepEqual(calls, [{ sessionId: "prior-session", offset: 0 }]);
  } finally { await bridge.close(); }
});
