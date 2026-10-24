import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { createSession } from "../../../src/storage/sessions.js";
import { createMidiArtifactAuthoringToolset } from "../../../src/app/midi/midi-artifact-tools.js";
import { inspectMidiArtifacts } from "../../../src/storage/midi-artifacts.js";

test("external MIDI authoring preserves the client identity without a model Profile", async (t) => {
  const storageDirectory = await mkdtemp("/private/tmp/live-smith-mcp-actor-");
  t.after(() => rm(storageDirectory, { recursive: true, force: true }));
  const session = await createSession(storageDirectory, { projectKey: "set", title: "External", scope: { kind: "selection", identity: "set", label: "Set" } });
  const actor = { kind: "mcp" as const, clientId: "client", clientName: "Composer" };
  const tools = createMidiArtifactAuthoringToolset({ storageDirectory, sessionId: session.id, actor, signal: new AbortController().signal });
  const result = await tools.callTool({ id: "save", name: "save_midi_artifact", arguments: JSON.stringify({ label: "Bass", durationBeats: 4,
    tracks: [{ name: "Bass", channel: 1, notes: [{ pitch: 48, startTime: 0, duration: 1, velocity: 90 }] }] }) });
  assert.equal(result.failed, undefined, result.content);
  const saved = await inspectMidiArtifacts(storageDirectory, session.id);
  assert.deepEqual(saved.artifacts[0]?.source, actor);
});
