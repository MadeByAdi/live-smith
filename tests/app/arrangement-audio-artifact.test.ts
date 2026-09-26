import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { AudioClip, AudioTrack } from "@ableton-extensions/sdk";

import { createHostAbortController } from "../../src/runtime/host.js";
import { listArrangementAudioArtifacts, readAudioAsset } from "../../src/storage/audio-assets.js";
import { createSession } from "../../src/storage/sessions.js";
import { stageArrangementAudioArtifact } from "../../src/app/arrangement-audio-artifact.js";

test("a verified Arrangement render becomes an opaque Session artifact", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-arrangement-artifact-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const renderedPath = path.join(directory, "private-render.wav");
  const bytes = waveBytes();
  await fs.writeFile(renderedPath, bytes);
  const { context, target } = arrangementFixture(renderedPath);
  const session = await createSession(directory, {
    title: "Analyze vocal", projectKey: "project", scope: { kind: "track", identity: "track", label: "Lead Vox" },
  });

  const result = await stageArrangementAudioArtifact({
    context: context as never, storageDirectory: directory, sessionId: session.id, target,
    request: { type: "stage_arrangement_audio_artifact", startBeat: 4, endBeat: 8 },
    signal: createHostAbortController().signal,
  });

  assert.match(result.content, /artifactRef/u);
  assert.match(result.content, /Pre-FX Arrangement audio/u);
  assert.doesNotMatch(result.content, /private-render|\.wav/u);
  const { asset, bytes: stored } = await readAudioAsset(directory, session.id, result.artifactRef);
  assert.deepEqual([...stored], [...bytes]);
  assert.equal(asset.role, "arrangement_render");
  assert.deepEqual(await listArrangementAudioArtifacts(directory, session.id), [asset]);
});

test("a failed or drifted Arrangement render creates no Session artifact", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-arrangement-artifact-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, {
    title: "Analyze vocal", projectKey: "project", scope: { kind: "track", identity: "track", label: "Lead Vox" },
  });
  const signal = createHostAbortController().signal;
  for (const mode of ["failure", "drift"] as const) {
    const renderedPath = path.join(directory, `${mode}.wav`);
    await fs.writeFile(renderedPath, waveBytes());
    const { context, target, song } = arrangementFixture(renderedPath);
    context.resources.renderPreFxAudio = async () => {
      if (mode === "failure") throw new Error("host render failed");
      song.tempo = 90;
      return renderedPath;
    };
    await assert.rejects(stageArrangementAudioArtifact({
      context: context as never, storageDirectory: directory, sessionId: session.id, target,
      request: { type: "stage_arrangement_audio_artifact", startBeat: 4, endBeat: 8 }, signal,
    }));
    assert.deepEqual(await listArrangementAudioArtifacts(directory, session.id), []);
  }
});

function arrangementFixture(renderedPath: string) {
  const clip = sdkObject<AudioClip<"1.0.0">>(AudioClip.prototype, {
    handle: { id: "clip" }, name: "Lead Vox", startTime: 0, endTime: 16, duration: 16,
    startMarker: 0, endMarker: 16, looping: false, loopStart: 0, loopEnd: 16, muted: false,
    filePath: "/private/source.wav", warping: true, warpMode: "complex", warpMarkers: [],
  });
  const track = sdkObject<AudioTrack<"1.0.0">>(AudioTrack.prototype, {
    handle: { id: "track" }, name: "Vox", arrangementClips: [clip], clipSlots: [],
  });
  const song = { tempo: 120, tracks: [track] };
  return {
    song,
    context: {
      application: { song },
      resources: { renderPreFxAudio: async () => renderedPath },
    },
    target: { track, clip },
  };
}

function sdkObject<T extends object>(prototype: object, properties: Record<string, unknown>): T {
  return Object.defineProperties(Object.create(prototype), Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [key, { value, enumerable: true, writable: true }]),
  )) as T;
}

function waveBytes(): Uint8Array {
  const bytes = Buffer.alloc(44 + 8_000);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(8_000, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(8_000, 40);
  return bytes;
}
