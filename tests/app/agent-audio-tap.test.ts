import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createHostAbortController } from "../../src/runtime/host.js";
import { listSessionAudioArtifacts, readAudioAsset } from "../../src/storage/audio-assets.js";
import { createSession } from "../../src/storage/sessions.js";
import {
  admitFinalizedAgentAudioTapCapture,
  captureMainWithAgentAudioTap,
  captureArrangementWithAgentAudioTap,
  captureSessionArrangementWithAgentAudioTap,
  createAgentAudioTapCaptureIntent,
  discoverAgentAudioTapListeners,
  formatAgentAudioTapListenersForReasoning,
  agentAudioTapListenersForReasoning,
  resolveAgentAudioTapCaptureTarget,
  resolveAgentAudioTapListener,
  writeAgentAudioTapCommand,
} from "../../src/app/agent-audio-tap.js";

test("the canonical Session capture operation resolves one requested listener and preserves its bounded Arrangement window", async () => {
  const listener = {
    tapId: "tap_song_123", trackName: "Song", trackType: "group" as const,
    canonicalParent: "live_set tracks 0", updatedAt: "2026-09-29T00:00:00.000Z",
  };
  const signal = createHostAbortController().signal;
  let captured: unknown;

  const result = await captureSessionArrangementWithAgentAudioTap({
    storageDirectory: "/private/tmp/live-smith-canonical-capture",
    sessionId: "session_123",
    signal,
    target: { kind: "listener", tapId: listener.tapId },
    window: { startBeat: 320, endBeat: 336 },
    discoverListeners: async () => [listener],
    capture: async (input) => {
      captured = input;
      return { artifactRef: "audio_artifact_123", captureId: "tapcapture_123", durationSeconds: 8, channels: 2 };
    },
  });

  const { onLifecycleStage, ...captureInput } = captured as Record<string, unknown>;
  assert.equal(typeof onLifecycleStage, "function");
  assert.deepEqual(captureInput, {
    storageDirectory: "/private/tmp/live-smith-canonical-capture",
    sessionId: "session_123",
    signal,
    listener,
    window: { startBeat: 320, endBeat: 336 },
  });
  assert.equal(result.listener, listener);
  assert.equal(result.artifactRef, "audio_artifact_123");
});

test("the canonical Session capture emits one bounded sanitized lifecycle result on success and failure", async () => {
  const listener = {
    tapId: "tap_song_123", trackName: "Song", trackType: "group" as const,
    canonicalParent: "live_set tracks 0", updatedAt: "2026-09-29T00:00:00.000Z",
  };
  const results: unknown[] = [];
  await captureSessionArrangementWithAgentAudioTap({
    storageDirectory: "/private/tmp/live-smith-capture-lifecycle",
    sessionId: "session_lifecycle_123",
    signal: createHostAbortController().signal,
    target: { kind: "listener", tapId: listener.tapId },
    window: { startBeat: 320, endBeat: 336 },
    discoverListeners: async () => [listener],
    capture: async (input) => {
      input.onLifecycleStage?.("arm");
      input.onLifecycleStage?.("arm_reached");
      input.onLifecycleStage?.("begin");
      input.onLifecycleStage?.("begin_reached");
      input.onLifecycleStage?.("stop_finalize");
      input.onLifecycleStage?.("stop_finalize_reached");
      input.onLifecycleStage?.("artifact_admission");
      input.onLifecycleStage?.("artifact_admitted");
      return { artifactRef: "audio_artifact_123", captureId: "tapcapture_123", durationSeconds: 8, channels: 2 };
    },
    onLifecycleResult: (result) => { results.push(result); },
  });
  await assert.rejects(captureSessionArrangementWithAgentAudioTap({
    storageDirectory: "/private/tmp/live-smith-capture-lifecycle",
    sessionId: "session_lifecycle_123",
    signal: createHostAbortController().signal,
    target: { kind: "main" },
    window: undefined,
    onLifecycleResult: (result) => { results.push(result); },
  }), /bounded Arrangement selection/u);
  assert.deepEqual(results, [
    {
      sessionId: "session_lifecycle_123", requestedListener: "listener", requestedTapId: "tap_song_123",
      range: { startBeat: 320, endBeat: 336 }, listenerResolved: true, armReached: true,
      beginReached: true, stopFinalizeReached: true, artifactAdmitted: true, outcome: "admitted",
    },
    {
      sessionId: "session_lifecycle_123", requestedListener: "main", requestedTapId: null,
      range: null, listenerResolved: false, armReached: false, beginReached: false,
      stopFinalizeReached: false, artifactAdmitted: false, outcome: "failed",
      failureStage: "range_validation", failureReason: "invalid_range",
    },
  ]);
});

test("a bounded Arrangement listen arms before it begins, finalizes at the selected end, and admits one targeted artifact", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-agent-listen-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Song", projectKey: "rnd", scope: { kind: "track", identity: "song", label: "Song" } });
  const command = path.join(directory, "agent_audio_tap_command.json");
  const listener = { tapId: "tap_123abc_456def", trackName: "Song", trackType: "group" as const, canonicalParent: "live_set tracks 0", updatedAt: new Date().toISOString() };
  let capturePath: string | undefined;
  const writeReceipt = async (capture: Record<string, unknown>) => {
    await fs.writeFile(`${command}.${listener.tapId}.status.json`, JSON.stringify({ ...listener,
      online: true, recording: capture.state === "recording", parentStatus: "ready", updatedAt: new Date().toISOString(), capture }));
  };
  const result = await captureArrangementWithAgentAudioTap({
    storageDirectory: directory, sessionId: session.id, signal: createHostAbortController().signal,
    listener, window: { startBeat: 49, endBeat: 57 }, commandFile: command,
    receiptPollIntervalMs: 1, receiptPollAttempts: 8, settleIntervalMs: 1, settleAttempts: 3,
    wait: async () => {
      const current = JSON.parse(await fs.readFile(command, "utf8")) as { id: string; command: string; path?: string; captureId?: string; windowId?: string; startBeat?: number; endBeat?: number };
      if (current.command === "arm") {
        capturePath = current.path;
        await writeReceipt({ id: current.id, captureId: current.captureId, windowId: current.windowId, state: "armed", startBeat: current.startBeat, endBeat: current.endBeat });
      }
      if (current.command === "begin") {
        await writeReceipt({ id: current.id, captureId: current.captureId, windowId: current.windowId, state: "recording", startBeat: current.startBeat, endBeat: current.endBeat });
        if (capturePath) await fs.writeFile(capturePath, stereoWaveBytes());
        await writeReceipt({ id: current.id, captureId: current.captureId, windowId: current.windowId, state: "stopped", startBeat: current.startBeat, endBeat: current.endBeat });
      }
    },
  });
  assert.match(result.artifactRef, /^audio_artifact_/u);
  assert.equal(result.captureId.startsWith("tapcapture_"), true);
  const artifact = await readAudioAsset(directory, session.id, result.artifactRef);
  assert.equal(artifact.asset.origin.kind, "agent_audio_tap");
  assert.equal(artifact.asset.origin.tapId, listener.tapId);
  assert.equal(artifact.asset.origin.startBeat, 49);
  assert.equal(artifact.asset.origin.endBeat, 57);
  assert.equal(artifact.asset.origin.windowId?.startsWith("tapwindow_"), true);
  assert.equal(JSON.parse(await fs.readFile(command, "utf8")).command, "begin");
});

test("live listener capture target resolution is exact, stable, and ambiguity-safe", () => {
  const listeners = [
    { tapId: "tap_main_123", trackName: "Main", trackType: "main" as const, canonicalParent: "live_set master_track", updatedAt: "2026-09-30T00:00:00.000Z" },
    { tapId: "tap_song_123", trackName: "Song", trackType: "group" as const, canonicalParent: "live_set tracks 0", updatedAt: "2026-09-30T00:00:00.000Z" },
    { tapId: "tap_vocals_a", trackName: "Vocals", trackType: "group" as const, canonicalParent: "live_set tracks 1", updatedAt: "2026-09-30T00:00:00.000Z" },
    { tapId: "tap_vocals_b", trackName: "vocals", trackType: "track" as const, canonicalParent: "live_set tracks 2", updatedAt: "2026-09-30T00:00:00.000Z" },
  ];

  assert.deepEqual(resolveAgentAudioTapCaptureTarget(listeners, { listenerName: "Song" }).target, {
    kind: "listener", tapId: "tap_song_123",
  });
  assert.deepEqual(resolveAgentAudioTapCaptureTarget(listeners, { listenerName: "Main" }).target, {
    kind: "main",
  });
  assert.deepEqual(resolveAgentAudioTapCaptureTarget(listeners, { listenerName: "Vocals", tapId: "tap_vocals_b" }).target, {
    kind: "listener", tapId: "tap_vocals_b",
  });
  assert.throws(() => resolveAgentAudioTapCaptureTarget(listeners, { listenerName: "Vocals" }), /Multiple live AgentAudioTap listeners/u);
  assert.throws(() => resolveAgentAudioTapCaptureTarget(listeners, { listenerName: "Drums" }), /No live AgentAudioTap listener named/u);
  assert.throws(() => resolveAgentAudioTapCaptureTarget([], { tapId: "tap_missing_123" }), /not online/u);
});

test("a bounded Arrangement listen refuses an invalid or unbounded beat window before commanding AgentAudioTap", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-agent-listen-invalid-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Song", projectKey: "rnd", scope: { kind: "track", identity: "song", label: "Song" } });
  await assert.rejects(captureArrangementWithAgentAudioTap({
    storageDirectory: directory, sessionId: session.id, signal: createHostAbortController().signal,
    listener: { tapId: "tap_123abc_456def", trackName: "Song", trackType: "group", canonicalParent: "live_set tracks 0", updatedAt: new Date().toISOString() },
    window: { startBeat: 49, endBeat: 49 }, commandFile: path.join(directory, "agent_audio_tap_command.json"),
  }), /bounded Arrangement selection/u);
});

test("a bounded Arrangement listen rejects an implausibly short finalized WAV before admitting an artifact", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-agent-listen-too-short-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Main", projectKey: "rnd", scope: { kind: "track", identity: "main", label: "Main" } });
  const command = path.join(directory, "agent_audio_tap_command.json");
  const listener = { tapId: "tap_123abc_456def", trackName: "Main", trackType: "main" as const, canonicalParent: "live_set master_track", updatedAt: new Date().toISOString() };
  let capturePath: string | undefined;
  const writeReceipt = async (capture: Record<string, unknown>) => {
    await fs.writeFile(`${command}.${listener.tapId}.status.json`, JSON.stringify({ ...listener,
      online: true, recording: capture.state === "recording", parentStatus: "ready", updatedAt: new Date().toISOString(), capture }));
  };
  await assert.rejects(captureArrangementWithAgentAudioTap({
    storageDirectory: directory, sessionId: session.id, signal: createHostAbortController().signal,
    listener, window: { startBeat: 320, endBeat: 336 }, commandFile: command,
    receiptPollIntervalMs: 1, receiptPollAttempts: 8, settleIntervalMs: 1, settleAttempts: 3,
    wait: async () => {
      const current = JSON.parse(await fs.readFile(command, "utf8")) as { id: string; command: string; path?: string; captureId?: string; windowId?: string; startBeat?: number; endBeat?: number };
      if (current.command === "arm") {
        capturePath = current.path;
        await writeReceipt({ id: current.id, captureId: current.captureId, windowId: current.windowId, state: "armed", startBeat: current.startBeat, endBeat: current.endBeat });
      }
      if (current.command === "begin") {
        await writeReceipt({ id: current.id, captureId: current.captureId, windowId: current.windowId, state: "recording", startBeat: current.startBeat, endBeat: current.endBeat });
        if (capturePath) await fs.writeFile(capturePath, stereoWaveBytes(0.02));
        await writeReceipt({ id: current.id, captureId: current.captureId, windowId: current.windowId, state: "stopped", startBeat: current.startBeat, endBeat: current.endBeat });
      }
    },
  }), /could not be confirmed|too short|invalid or changed before admission/u);
  assert.deepEqual(await listSessionAudioArtifacts(directory, session.id), []);
});

test("a finalized stereo upstream AgentAudioTap capture becomes an opaque Session artifact", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-agent-tap-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Main", projectKey: "rnd", scope: { kind: "track", identity: "main", label: "Main" } });
  const capture = path.join(directory, "capture.wav");
  await fs.writeFile(capture, stereoWaveBytes());
  const result = await admitFinalizedAgentAudioTapCapture({ storageDirectory: directory, sessionId: session.id,
    intent: createAgentAudioTapCaptureIntent(), completedPath: capture, signal: createHostAbortController().signal });
  assert.match(result.artifactRef, /^audio_artifact_/u);
  assert.equal(result.channels, 2);
  assert.equal((await readAudioAsset(directory, session.id, result.artifactRef)).asset.origin.kind, "agent_audio_tap");
  assert.deepEqual((await listSessionAudioArtifacts(directory, session.id)).map((asset) => asset.id), [result.artifactRef]);
});

test("the adapter writes only opaque unique upstream start/stop commands", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-agent-command-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const command = path.join(directory, "command.json");
  await writeAgentAudioTapCommand(command, { id: "tapcapture_123", command: "start", path: "/private/tmp/capture.wav" });
  assert.deepEqual(JSON.parse(await fs.readFile(command, "utf8")), { id: "tapcapture_123", command: "start", path: "/private/tmp/capture.wav" });
  await assert.rejects(writeAgentAudioTapCommand(command, { id: "tapcapture_123", command: "start" }), /absolute host-owned/u);
});

test("fresh listener receipts are bounded and resolve only their stable tap ID", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-agent-listeners-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const command = path.join(directory, "agent_audio_tap_command.json");
  const listener = { tapId: "tap_123abc_456def", trackName: "Song", trackType: "group", canonicalParent: "live_set tracks 0",
    online: true, recording: false, parentStatus: "ready", updatedAt: new Date().toISOString() };
  await fs.writeFile(`${command}.${listener.tapId}.status.json`, JSON.stringify(listener));
  await fs.writeFile(`${command}.tap_stale_000.status.json`, JSON.stringify({ ...listener, tapId: "tap_stale_000", updatedAt: "2000-01-01T00:00:00.000Z" }));
  const listeners = await discoverAgentAudioTapListeners({ commandFile: command });
  assert.deepEqual(listeners, [{ tapId: listener.tapId, trackName: "Song", trackType: "group", canonicalParent: "live_set tracks 0", updatedAt: listener.updatedAt }]);
  assert.equal(resolveAgentAudioTapListener(listeners, listener.tapId).trackName, "Song");
  assert.throws(() => resolveAgentAudioTapListener(listeners, "tap_missing_000"), /not online/u);
});

test("fresh Song and Main listeners are discovered after more than 64 stale receipts", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-agent-listeners-many-stale-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const command = path.join(directory, "agent_audio_tap_command.json");
  const stale = {
    trackName: "Old listener", trackType: "track", canonicalParent: "live_set tracks 99",
    online: true, recording: false, parentStatus: "ready", updatedAt: "2000-01-01T00:00:00.000Z",
  };
  for (let index = 0; index < 65; index += 1) {
    await fs.writeFile(`${command}.tap_stale_${String(index).padStart(3, "0")}.status.json`, JSON.stringify({
      ...stale, tapId: `tap_stale_${String(index).padStart(3, "0")}`,
    }));
  }
  const now = new Date().toISOString();
  const live = [
    { tapId: "tap_zz_song_123", trackName: "Song", trackType: "group", canonicalParent: "live_set tracks 0" },
    { tapId: "tap_zz_main_123", trackName: "Main", trackType: "main", canonicalParent: "live_set master_track" },
  ];
  for (const listener of live) {
    await fs.writeFile(`${command}.${listener.tapId}.status.json`, JSON.stringify({
      ...listener, online: true, recording: false, parentStatus: "ready", updatedAt: now,
    }));
  }

  const listeners = await discoverAgentAudioTapListeners({ commandFile: command });

  assert.deepEqual(listeners.map(({ tapId, trackName }) => ({ tapId, trackName })), [
    { tapId: "tap_zz_main_123", trackName: "Main" },
    { tapId: "tap_zz_song_123", trackName: "Song" },
  ]);
});

test("listener reasoning view exposes compact live identity and safe ambiguity", () => {
  const listeners = [
    { tapId: "tap_main_123", trackName: "Main", trackType: "main" as const, canonicalParent: "live_set master_track", updatedAt: "2026-09-30T00:00:00.000Z" },
    { tapId: "tap_song_123", trackName: "Song", trackType: "group" as const, canonicalParent: "live_set tracks 0", updatedAt: "2026-09-30T00:00:00.000Z" },
    { tapId: "tap_vocals_a", trackName: "Vocals", trackType: "group" as const, canonicalParent: "live_set tracks 1", updatedAt: "2026-09-30T00:00:00.000Z" },
    { tapId: "tap_vocals_b", trackName: "vocals", trackType: "track" as const, canonicalParent: "live_set tracks 2", updatedAt: "2026-09-30T00:00:00.000Z" },
  ];

  assert.deepEqual(agentAudioTapListenersForReasoning(listeners), [
    { tapId: "tap_main_123", trackName: "Main", trackType: "main", canonicalParent: "live_set master_track", ambiguousName: false },
    { tapId: "tap_song_123", trackName: "Song", trackType: "group", canonicalParent: "live_set tracks 0", ambiguousName: false },
    { tapId: "tap_vocals_a", trackName: "Vocals", trackType: "group", canonicalParent: "live_set tracks 1", ambiguousName: true },
    { tapId: "tap_vocals_b", trackName: "vocals", trackType: "track", canonicalParent: "live_set tracks 2", ambiguousName: true },
  ]);

  const context = formatAgentAudioTapListenersForReasoning(listeners);
  assert.match(context, /Live AgentAudioTap listeners \(read-only, fresh registry\)/u);
  assert.match(context, /trackName: "Main"; trackType: main; canonicalParent: "live_set master_track"; ambiguousName: false/u);
  assert.match(context, /trackName: "Song"; trackType: group; canonicalParent: "live_set tracks 0"; ambiguousName: false/u);
  assert.match(context, /trackName: "Vocals"; trackType: group; canonicalParent: "live_set tracks 1"; ambiguousName: true/u);
});

test("listener reasoning context reflects the current live parent name after rename", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-agent-listeners-rename-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const command = path.join(directory, "agent_audio_tap_command.json");
  const status = `${command}.tap_song_123.status.json`;
  const base = {
    tapId: "tap_song_123", trackType: "group", canonicalParent: "live_set tracks 0",
    online: true, recording: false, parentStatus: "ready", updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(status, JSON.stringify({ ...base, trackName: "Song" }));
  assert.match(formatAgentAudioTapListenersForReasoning(
    await discoverAgentAudioTapListeners({ commandFile: command }),
  ), /trackName: "Song"/u);

  await fs.writeFile(status, JSON.stringify({ ...base, trackName: "Renamed Song", updatedAt: new Date().toISOString() }));
  const context = formatAgentAudioTapListenersForReasoning(
    await discoverAgentAudioTapListeners({ commandFile: command }),
  );
  assert.match(context, /trackName: "Renamed Song"/u);
  assert.doesNotMatch(context, /trackName: "Song"/u);
});

test("a bounded capture writes start and stop, then admits only a finalized Main artifact", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-agent-capture-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Main", projectKey: "rnd", scope: { kind: "track", identity: "main", label: "Main" } });
  const command = path.join(directory, "upstream-command.json");
  let capturePath: string | undefined;
  const result = await captureMainWithAgentAudioTap({
    storageDirectory: directory,
    sessionId: session.id,
    signal: createHostAbortController().signal,
    commandFile: command,
    captureWindowMs: 1,
    settleIntervalMs: 1,
    settleAttempts: 3,
    wait: async () => {
      const current = JSON.parse(await fs.readFile(command, "utf8")) as { command: string; path?: string };
      if (current.command === "start") capturePath = current.path;
      if (current.command === "stop" && capturePath) {
        await fs.writeFile(capturePath, stereoWaveBytes());
      }
    },
  });
  assert.match(result.artifactRef, /^audio_artifact_/u);
  assert.equal(result.channels, 2);
  assert.equal(JSON.parse(await fs.readFile(command, "utf8")).command, "stop");
  const artifact = await readAudioAsset(directory, session.id, result.artifactRef);
  assert.equal(artifact.asset.origin.kind, "agent_audio_tap");
  assert.equal(artifact.asset.origin.scope, "main");
});

test("a missing or unfinalized upstream capture fails without admitting an artifact", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-agent-capture-fail-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Main", projectKey: "rnd", scope: { kind: "track", identity: "main", label: "Main" } });
  await assert.rejects(captureMainWithAgentAudioTap({
    storageDirectory: directory,
    sessionId: session.id,
    signal: createHostAbortController().signal,
    commandFile: path.join(directory, "upstream-command.json"),
    captureWindowMs: 1,
    settleIntervalMs: 1,
    settleAttempts: 2,
    wait: async () => {},
  }), /did not finalize/u);
});

function stereoWaveBytes(durationSeconds = 2): Buffer {
  const frames = Math.max(1, Math.floor(44_100 * durationSeconds));
  const data = Buffer.alloc(44 + frames * 2 * 2);
  data.write("RIFF", 0, "ascii"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8, "ascii");
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(44_100, 24);
  data.writeUInt32LE(176_400, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write("data", 36, "ascii"); data.writeUInt32LE(data.length - 44, 40);
  data.writeInt16LE(1200, 44); data.writeInt16LE(-1200, 46);
  return data;
}
