import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  assertVst3ChatBridgeLaunchUrl,
  createVst3HandoffOpener,
} from "../../src/runtime/vst3-handoff.js";

const launchUrl = "http://127.0.0.1:4620/chat?launch=123e4567-e89b-12d3-a456-426614174000";
const tokenUrl = "http://127.0.0.1:4620/chat?token=123e4567-e89b-12d3-a456-426614174000";

test("the VST3 handoff writes the authenticated local chat URL to Extension Data", async () => {
  const calls: Array<{ kind: "mkdir" | "writeFile"; args: unknown[] }> = [];
  const openChatInVst3 = createVst3HandoffOpener({
    homeDirectory: "/Users/adi",
    mkdir: async (...args) => {
      calls.push({ kind: "mkdir", args });
    },
    writeFile: async (...args) => {
      calls.push({ kind: "writeFile", args });
    },
  });

  await openChatInVst3(launchUrl);

  const directory = path.join(
    "/Users/adi",
    "Library",
    "Application Support",
    "Ableton",
    "Extensions Data",
    "sam-kuler.live-smith",
  );
  assert.deepEqual(calls, [
    { kind: "mkdir", args: [directory, { recursive: true }] },
    {
      kind: "writeFile",
      args: [
        path.join(directory, "vst3-bridge-url.txt"),
        `${launchUrl}\n`,
        { encoding: "utf8", mode: 0o600 },
      ],
    },
  ]);
});

test("the VST3 handoff accepts launch and token ChatBridge tickets", () => {
  assert.doesNotThrow(() => assertVst3ChatBridgeLaunchUrl(launchUrl));
  assert.doesNotThrow(() => assertVst3ChatBridgeLaunchUrl(tokenUrl));
});

test("the VST3 handoff rejects unauthenticated or non-local chat URLs before writing", async () => {
  let writes = 0;
  const openChatInVst3 = createVst3HandoffOpener({
    homeDirectory: "/Users/adi",
    writeFile: async () => {
      writes += 1;
    },
  });

  for (const url of [
    "https://127.0.0.1:4620/chat?launch=123e4567-e89b-12d3-a456-426614174000",
    "http://localhost:4620/chat?launch=123e4567-e89b-12d3-a456-426614174000",
    "http://127.0.0.1/chat?launch=123e4567-e89b-12d3-a456-426614174000",
    "http://127.0.0.1:4620/harness.html?launch=123e4567-e89b-12d3-a456-426614174000",
    "http://user:pass@127.0.0.1:4620/chat?launch=123e4567-e89b-12d3-a456-426614174000",
    "http://127.0.0.1:4620/chat?launch=123e4567-e89b-12d3-a456-426614174000#secret",
    "http://127.0.0.1:4620/chat?launch=123e4567-e89b-12d3-a456-426614174000&token=123e4567-e89b-12d3-a456-426614174000",
    "http://127.0.0.1:4620/chat?launch=not-a-ticket",
    "not a url",
  ]) {
    await assert.rejects(openChatInVst3(url), /local ChatBridge launch URL/i);
  }
  assert.equal(writes, 0);
});

test("the VST3 handoff preserves cancellation before filesystem writes", async () => {
  const controller = new AbortController();
  const reason = new Error("Stop handoff.");
  let writes = 0;
  const openChatInVst3 = createVst3HandoffOpener({
    homeDirectory: "/Users/adi",
    mkdir: async () => {
      controller.abort(reason);
    },
    writeFile: async () => {
      writes += 1;
    },
  });

  await assert.rejects(openChatInVst3(launchUrl, controller.signal), (error) => {
    assert.equal(error, reason);
    return true;
  });
  assert.equal(writes, 0);
});
