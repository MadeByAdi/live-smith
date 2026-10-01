import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createHostAbortController } from "../../src/runtime/host.js";
import { saveAgentAudioTapArtifact, saveArrangementAudioArtifact } from "../../src/storage/audio-assets.js";
import { createSession } from "../../src/storage/sessions.js";
import {
  formatSessionAudioArtifactsForReasoning,
  sessionAudioArtifactsForReasoning,
} from "../../src/app/audio-artifact-context.js";

test("Session audio evidence context exposes same-Session captures and source renders without paths", async (t) => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-audio-evidence-context-"));
  t.after(() => fs.rm(storage, { recursive: true, force: true }));
  const signal = createHostAbortController().signal;
  const session = await createSession(storage, { title: "Song", projectKey: "project", scope: { kind: "track", identity: "song", label: "Song" } });
  const other = await createSession(storage, { title: "Other", projectKey: "project", scope: { kind: "track", identity: "other", label: "Other" } });

  const source = await saveArrangementAudioArtifact(storage, session.id, {
    label: "Pre-FX Arrangement audio: Lead Vox, beats 320-336",
    bytes: monoWaveBytes(2),
    origin: { kind: "arrangement", startBeat: 320, endBeat: 336, tempo: 91 },
    signal,
  });
  const song = await saveAgentAudioTapArtifact(storage, session.id, {
    label: "Song capture from upstream AgentAudioTap",
    bytes: stereoWaveBytes(11),
    captureId: "tapcapture_song_123",
    origin: {
      kind: "agent_audio_tap",
      captureId: "tapcapture_song_123",
      scope: "listener",
      tapPosition: "track_insertion_point",
      startBeat: 320,
      endBeat: 336,
      tapId: "tap_song_123",
      trackName: "Song",
      trackType: "group",
      canonicalParent: "live_set tracks 0",
      windowId: "tapwindow_song_123",
    },
    signal,
  });
  const main = await saveAgentAudioTapArtifact(storage, session.id, {
    label: "Main capture from upstream AgentAudioTap",
    bytes: stereoWaveBytes(11),
    captureId: "tapcapture_main_123",
    origin: {
      kind: "agent_audio_tap",
      captureId: "tapcapture_main_123",
      scope: "main",
      tapPosition: "main_insertion_point",
      startBeat: 320,
      endBeat: 336,
    },
    signal,
  });
  const hidden = await saveAgentAudioTapArtifact(storage, other.id, {
    label: "Other Session Main capture",
    bytes: stereoWaveBytes(11),
    captureId: "tapcapture_other_123",
    signal,
  });

  const audioDirectory = path.join(storage, "live-smith-audio", session.id);
  await fs.utimes(path.join(audioDirectory, `${source.id}.asset.json`), new Date("2026-09-30T00:00:01.000Z"), new Date("2026-09-30T00:00:01.000Z"));
  await fs.utimes(path.join(audioDirectory, `${song.id}.asset.json`), new Date("2026-09-30T00:00:02.000Z"), new Date("2026-09-30T00:00:02.000Z"));
  await fs.utimes(path.join(audioDirectory, `${main.id}.asset.json`), new Date("2026-09-30T00:00:03.000Z"), new Date("2026-09-30T00:00:03.000Z"));

  const views = await sessionAudioArtifactsForReasoning(storage, session.id);

  assert.deepEqual(views.map((view) => view.artifactRef), [main.id, song.id, source.id]);
  assert.equal(views[0]!.method, "agent_audio_tap_capture");
  assert.deepEqual(views[0]!.provenance, {
    kind: "agent_audio_tap",
    captureId: "tapcapture_main_123",
    scope: "main",
    tapPosition: "main_insertion_point",
    startBeat: 320,
    endBeat: 336,
  });
  assert.deepEqual(views[1]!.provenance, {
    kind: "agent_audio_tap",
    captureId: "tapcapture_song_123",
    scope: "listener",
    tapPosition: "track_insertion_point",
    startBeat: 320,
    endBeat: 336,
    tapId: "tap_song_123",
    trackName: "Song",
    trackType: "group",
    canonicalParent: "live_set tracks 0",
    windowId: "tapwindow_song_123",
  });
  assert.equal(views[2]!.method, "arrangement_pre_fx_render");
  assert.deepEqual(views[2]!.provenance, {
    kind: "arrangement",
    source: "isolated Arrangement audio render",
    renderPoint: "pre_fx_source",
    startBeat: 320,
    endBeat: 336,
    tempo: 91,
  });
  assert.equal(views.some((view) => view.artifactRef === hidden.id), false);

  const context = await formatSessionAudioArtifactsForReasoning(storage, session.id);
  assert.match(context, /Current Session audio evidence \(read-only, newest first\)/u);
  assert.match(context, new RegExp(main.id, "u"));
  assert.match(context, new RegExp(song.id, "u"));
  assert.match(context, /"trackName":"Song"/u);
  assert.match(context, /"startBeat":320/u);
  assert.doesNotMatch(context, new RegExp(hidden.id, "u"));
  assert.doesNotMatch(context, new RegExp("/private/|/var/|live-smith-audio|\\.audio|\\.asset\\.json", "u"));
});

function monoWaveBytes(durationSeconds = 2): Uint8Array {
  const sampleRate = 8_000;
  const frames = Math.max(1, Math.floor(sampleRate * durationSeconds));
  const bytes = Buffer.alloc(44 + frames);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate, 28); bytes.writeUInt16LE(1, 32); bytes.writeUInt16LE(8, 34); bytes.write("data", 36, "ascii"); bytes.writeUInt32LE(bytes.length - 44, 40);
  return new Uint8Array(bytes);
}

function stereoWaveBytes(durationSeconds = 2): Uint8Array {
  const frames = Math.max(1, Math.floor(44_100 * durationSeconds));
  const data = Buffer.alloc(44 + frames * 2 * 2);
  data.write("RIFF", 0, "ascii"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8, "ascii");
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(2, 22); data.writeUInt32LE(44_100, 24);
  data.writeUInt32LE(176_400, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34); data.write("data", 36, "ascii"); data.writeUInt32LE(data.length - 44, 40);
  data.writeInt16LE(1200, 44); data.writeInt16LE(-1200, 46);
  return new Uint8Array(data);
}
