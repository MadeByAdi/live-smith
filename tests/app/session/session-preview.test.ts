import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { readSessionPreview } from "../../../src/app/session/session-preview.js";
import { createSession, setSessionArchived } from "../../../src/storage/sessions.js";
import { appendSessionEvent } from "../../../src/storage/events.js";

test("historical preview projects bounded saved messages and artifact references without tool data", async (t) => {
  const storageDirectory = await fs.mkdtemp("/private/tmp/live-smith-preview-");
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const historical = await createSession(storageDirectory, { title: "Past Set", projectKey: "prior-project",
    scope: { kind: "track", identity: "old-handle", label: "Lead" } });
  const current = await createSession(storageDirectory, { title: "Current Set", projectKey: "current-project",
    scope: { kind: "object", identity: "current-handle", label: "Set" } });
  const artifact = { kind: "audio" as const, id: "saved-audio" };
  await appendSessionEvent(storageDirectory, historical.id, { kind: "tool_result", content: "PRIVATE_AUTH_TOKEN", artifacts: [artifact] });
  await appendSessionEvent(storageDirectory, historical.id, { kind: "user", content: "old prompt" });
  await appendSessionEvent(storageDirectory, historical.id, { kind: "assistant", content: "x".repeat(4100) });
  const input = { storageDirectory, projectKey: "current-project", signal: new AbortController().signal };
  const preview = await readSessionPreview({ ...input, sessionId: historical.id, offset: 0 });
  assert.equal(preview.title, "Past Set");
  assert.equal(preview.total, 2);
  assert.deepEqual(preview.messages.map(({ kind }) => kind), ["user", "assistant"]);
  assert.equal(preview.messages[1]?.content.length, 4000);
  assert.equal(preview.messages[1]?.truncated, true);
  assert.deepEqual(preview.artifacts, [artifact]);
  assert.equal(JSON.stringify(preview).includes("PRIVATE_AUTH_TOKEN"), false);
  assert.deepEqual((await readSessionPreview({ ...input, sessionId: historical.id, offset: 1 })).messages.map(({ kind }) => kind), ["assistant"]);
  await assert.rejects(readSessionPreview({ ...input, sessionId: current.id, offset: 0 }), /unavailable/);
  await assert.rejects(readSessionPreview({ ...input, sessionId: "missing-session", offset: 0 }), /unavailable/);
  await setSessionArchived(storageDirectory, historical.id, true);
  await assert.rejects(readSessionPreview({ ...input, sessionId: historical.id, offset: 0 }), /unavailable/);
});
