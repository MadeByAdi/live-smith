import assert from "node:assert/strict";
import test from "node:test";

import { parseCommandInput } from "../../../../src/app/chat/chat-bridge-http.js";

test("AgentAudioTap manual capture commands survive bridge command parsing", () => {
  const main = { kind: "capture_main_for_analysis", sessionId: "session-agent-tap" } as const;
  const listener = {
    kind: "capture_listener_for_analysis",
    sessionId: "session-agent-tap",
    tapId: "tap_1a0eff33645_6db3925",
  } as const;

  assert.deepEqual(parseCommandInput(main), main);
  assert.deepEqual(parseCommandInput(listener), listener);
});

test("AgentAudioTap manual capture commands reject malformed or unrelated payloads", () => {
  const main = { kind: "capture_main_for_analysis", sessionId: "session-agent-tap" };
  const listener = {
    kind: "capture_listener_for_analysis",
    sessionId: "session-agent-tap",
    tapId: "tap_1a0eff33645_6db3925",
  };

  assert.throws(() => parseCommandInput({ ...main, tapId: "tap_extra" }));
  assert.throws(() => parseCommandInput({ ...main, sessionId: "../session" }));
  assert.throws(() => parseCommandInput({ ...listener, tapId: "../tap" }));
  assert.throws(() => parseCommandInput({ ...listener, listenerName: "Song" }));
  assert.throws(() => parseCommandInput({ kind: "capture_unknown_for_analysis", sessionId: "session-agent-tap" }));
});
