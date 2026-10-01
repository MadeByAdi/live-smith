import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { AudioAsset } from "../audio-services/contracts.js";
import { listSessionAudioArtifacts } from "../storage/audio-assets.js";
import { bindAudioDirectory } from "../storage/audio-jobs.js";

export interface SessionAudioArtifactReasoningView {
  artifactRef: string;
  role: "arrangement_render" | "agent_audio_tap";
  method: "arrangement_pre_fx_render" | "agent_audio_tap_capture";
  label: string;
  storedAt: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  mediaType: AudioAsset["mediaType"];
  byteLength: number;
  provenance: Record<string, unknown>;
}

function artifactMethod(asset: AudioAsset): SessionAudioArtifactReasoningView["method"] {
  return asset.role === "arrangement_render" ? "arrangement_pre_fx_render" : "agent_audio_tap_capture";
}

function artifactProvenance(asset: AudioAsset): Record<string, unknown> {
  if (asset.origin.kind === "arrangement") {
    return {
      kind: "arrangement",
      source: "isolated Arrangement audio render",
      renderPoint: "pre_fx_source",
      ...(asset.origin.startBeat === undefined ? {} : { startBeat: asset.origin.startBeat }),
      ...(asset.origin.endBeat === undefined ? {} : { endBeat: asset.origin.endBeat }),
      ...(asset.origin.tempo === undefined ? {} : { tempo: asset.origin.tempo }),
    };
  }
  if (asset.origin.kind === "agent_audio_tap") {
    return {
      kind: "agent_audio_tap",
      captureId: asset.origin.captureId,
      scope: asset.origin.scope,
      tapPosition: asset.origin.tapPosition,
      ...(asset.origin.startBeat === undefined ? {} : { startBeat: asset.origin.startBeat }),
      ...(asset.origin.endBeat === undefined ? {} : { endBeat: asset.origin.endBeat }),
      ...(asset.origin.tapId === undefined ? {} : { tapId: asset.origin.tapId }),
      ...(asset.origin.trackName === undefined ? {} : { trackName: asset.origin.trackName }),
      ...(asset.origin.trackType === undefined ? {} : { trackType: asset.origin.trackType }),
      ...(asset.origin.canonicalParent === undefined ? {} : { canonicalParent: asset.origin.canonicalParent }),
      ...(asset.origin.windowId === undefined ? {} : { windowId: asset.origin.windowId }),
    };
  }
  return { kind: asset.origin.kind };
}

export async function sessionAudioArtifactsForReasoning(
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<SessionAudioArtifactReasoningView[]> {
  if (!storageDirectory) return [];
  const directory = await bindAudioDirectory(storageDirectory, sessionId);
  if (!directory) return [];
  const artifacts = await listSessionAudioArtifacts(storageDirectory, sessionId);
  const views = await Promise.all(artifacts.map(async (asset) => {
    const info = await fs.stat(path.join(directory.directory, `${asset.id}.asset.json`));
    return {
      artifactRef: asset.id,
      role: asset.role as SessionAudioArtifactReasoningView["role"],
      method: artifactMethod(asset),
      label: asset.label,
      storedAt: new Date(info.mtimeMs).toISOString(),
      durationSeconds: asset.durationSeconds,
      sampleRate: asset.sampleRate,
      channels: asset.channels,
      mediaType: asset.mediaType,
      byteLength: asset.byteLength,
      provenance: artifactProvenance(asset),
    };
  }));
  return views.sort((a, b) => {
    const byTime = Date.parse(b.storedAt) - Date.parse(a.storedAt);
    return byTime === 0 ? b.artifactRef.localeCompare(a.artifactRef) : byTime;
  });
}

export async function formatSessionAudioArtifactsForReasoning(
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<string> {
  const artifacts = await sessionAudioArtifactsForReasoning(storageDirectory, sessionId);
  if (!artifacts.length) return "";
  return [
    "Current Session audio evidence (read-only, newest first):",
    "Use only these opaque artifactRef values for later same-Session audio evidence reasoning. No filesystem paths are available. Do not assume an older processed capture is current unless freshness is established by provenance and storedAt.",
    ...artifacts.map((artifact) => JSON.stringify(artifact)),
  ].join("\n");
}
