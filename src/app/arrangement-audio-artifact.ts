import type { ExtensionContext } from "@ableton-extensions/sdk";

import type { AgentObservationRequest } from "../agent/actions.js";
import { MAX_AUDIO_ASSET_BYTES, MAX_AUDIO_ASSET_DURATION_SECONDS } from "../audio-services/contracts.js";
import { readArrangementAudio } from "../live/observer.js";
import type { LiveTarget } from "../live/target.js";
import { saveArrangementAudioArtifact } from "../storage/audio-assets.js";

export async function stageArrangementAudioArtifact(input: {
  context: ExtensionContext<"1.0.0">;
  storageDirectory: string | undefined;
  sessionId: string;
  target: LiveTarget;
  request: Extract<AgentObservationRequest, { type: "stage_arrangement_audio_artifact" }>;
  signal: AbortSignal;
}): Promise<{ artifactRef: string; content: string }> {
  const rendered = await readArrangementAudio(
    input.context,
    { ...input.request, type: "read_arrangement_audio" },
    input.target,
    input.signal,
    { maxBytes: MAX_AUDIO_ASSET_BYTES, maxDurationSeconds: MAX_AUDIO_ASSET_DURATION_SECONDS },
  );
  const asset = await saveArrangementAudioArtifact(input.storageDirectory, input.sessionId, {
    label: `Pre-FX Arrangement audio render, beats ${input.request.startBeat}-${input.request.endBeat}`,
    bytes: rendered.bytes,
    origin: {
      kind: "arrangement",
      startBeat: input.request.startBeat,
      endBeat: input.request.endBeat,
      tempo: input.context.application.song.tempo,
    },
    signal: input.signal,
  });
  return {
    artifactRef: asset.id,
    content: JSON.stringify({
      artifactRef: asset.id,
      label: asset.label,
      mediaType: asset.mediaType,
      durationSeconds: asset.durationSeconds,
      scope: "Verified pre-FX audio from the requested isolated Arrangement Clip range; it excludes track devices, sends, returns, master processing, and other tracks.",
      usage: "Pass this exact artifactRef to an approved local Plugin tool that requests an audio artifact. Never use a clip name or filesystem path.",
    }),
  };
}
