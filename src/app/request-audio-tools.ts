import type { ExtensionContext } from "@ableton-extensions/sdk";
import {
  audioProcessingTools, parseAudioToolRequest, validateAudioServiceRequest, type AudioProcessingSource,
} from "../agent/audio-tools.js";
import type { AgentExternalToolResult } from "../agent/loop.js";
import {
  MAX_AUDIO_ASSET_BYTES, MAX_AUDIO_ASSET_DURATION_SECONDS,
  type AudioAsset, type AudioOrigin,
} from "../audio-services/contracts.js";
import { readArrangementAudio } from "../live/observer.js";
import type { LiveTarget } from "../live/target.js";
import type { ModelToolCall } from "../model/contracts.js";
import { readAudioAsset } from "../storage/audio-assets.js";
import { listAudioJobs } from "../storage/audio-jobs.js";
import { readSessionAttachmentBytes, type AudioSessionAttachmentRef } from "../storage/attachments.js";
import { throwIfAborted } from "../runtime/host.js";
import {
  audioAssetsFromJobs, audioJobResultText, audioJobViews,
  resumeAudioJob, separateAudioStems,
  type AudioProcessingContext,
} from "./audio-processing.js";
import { captureAudioServiceConnections } from "./audio-service-connections.js";
import { generateAudio } from "./audio-generation.js";

export async function createRequestAudioTools(input: {
  context: ExtensionContext<"1.0.0">;
  storageDirectory: string | undefined;
  sessionId: string;
  requestId: string;
  attachmentRefs: readonly AudioSessionAttachmentRef[];
  target: LiveTarget;
  signal: AbortSignal;
  onProgress(message: string): Promise<void> | void;
  onAssets(assets: readonly AudioAsset[]): Promise<void> | void;
  /** Test seam; production uses the saved service and shared network route. */
  processing?: Pick<AudioProcessingContext, "adapter" | "generationAdapter" | "wait">;
}) {
  const admittedConnections = await captureAudioServiceConnections(input.storageDirectory);
  const services = admittedConnections.map(({ id, name, provider }) => ({ id, name, provider }));
  const jobs = input.storageDirectory ? await listAudioJobs(input.storageDirectory, input.sessionId) : [];
  const assets = new Map<string, AudioAsset>();
  const registerAssets = async (values: readonly AudioAsset[]): Promise<void> => {
    for (const asset of values) assets.set(asset.id, asset);
    await input.onAssets(values);
  };
  await registerAssets(audioAssetsFromJobs(jobs));
  const tools = services.length || jobs.length ? audioProcessingTools(services) : [];
  const processing: AudioProcessingContext = {
    storageDirectory: input.storageDirectory, sessionId: input.sessionId,
    signal: input.signal, onProgress: input.onProgress, ...input.processing,
    admittedConnections,
  };

  const snapshot = async (source: AudioProcessingSource): Promise<{
    bytes: Uint8Array; label: string; origin: AudioOrigin;
  }> => {
    if (source.kind === "request_audio_attachment") {
      if (source.requestId !== input.requestId) throw new Error("Audio attachment locator is not from the current request.");
      const ref = input.attachmentRefs[source.audioIndex];
      if (!ref) throw new Error("Audio attachment is unavailable in this request.");
      const bytes = await readSessionAttachmentBytes(input.storageDirectory, input.sessionId, ref.id, {
        expectedRef: ref, signal: input.signal,
      });
      return { bytes, label: "Audio attachment", origin: { kind: "attachment" } };
    }
    if (source.kind === "audio_asset") {
      const expected = assets.get(source.assetRef);
      if (!expected) throw new Error("Audio asset reference is unavailable. Use list_audio_jobs to read this Session's current results.");
      const { asset, bytes } = await readAudioAsset(input.storageDirectory, input.sessionId, source.assetRef, input.signal);
      if (asset.sha256 !== expected.sha256) throw new Error("Audio asset changed after it was observed.");
      return { bytes, label: asset.label, origin: { ...asset.origin, kind: "asset", sourceAssetId: asset.id } };
    }
    const { kind: _kind, ...locator } = source;
    const tempo = input.context.application.song.tempo;
    const render = await readArrangementAudio(
      input.context, { type: "read_arrangement_audio", ...locator }, input.target,
      input.signal, { maxBytes: MAX_AUDIO_ASSET_BYTES, maxDurationSeconds: MAX_AUDIO_ASSET_DURATION_SECONDS },
    );
    return {
      bytes: render.bytes, label: "Arrangement audio snapshot",
      origin: { kind: "arrangement", startBeat: source.startBeat, endBeat: source.endBeat, tempo },
    };
  };

  return {
    tools,
    async execute(call: ModelToolCall): Promise<AgentExternalToolResult> {
      let request;
      try {
        request = parseAudioToolRequest(call.name, call.arguments);
        validateAudioServiceRequest(request, services);
      } catch {
        return { content: "Invalid audio tool arguments. Use only the declared fields, connection IDs, source references and generation limits.", failed: true, invalidArguments: true };
      }
      try {
        if (request.kind === "list_audio_jobs") {
          const current = await listAudioJobs(input.storageDirectory, input.sessionId);
          await registerAssets(audioAssetsFromJobs(current));
          return { content: JSON.stringify(await audioJobViews(input.storageDirectory, input.sessionId)), progressKey: JSON.stringify(current.map((job) => [job.id, job.updatedAt])) };
        }
        const job = request.kind === "resume_audio_job"
          ? await resumeAudioJob(processing, request.jobId)
          : request.kind === "separate_stems"
          ? await separateAudioStems(processing, request.serviceId, request.stems, () => snapshot(request.source))
          : await generateAudio(processing, request.serviceId, request.kind === "generate_music"
            ? { operation: request.kind, prompt: request.prompt, instrumental: request.instrumental,
              ...(request.durationSeconds === undefined ? {} : { durationSeconds: request.durationSeconds }) }
            : { operation: request.kind, prompt: request.prompt, durationSeconds: request.durationSeconds, loop: request.loop });
        await registerAssets(job.outputAssets);
        throwIfAborted(input.signal);
        return {
          content: audioJobResultText(job), progressKey: `${job.id}:${job.updatedAt}`,
          ...(job.status === "unknown" || job.status === "failed" || job.status === "interrupted" || job.status === "partial"
            ? { failed: true, stop: true } : {}),
        };
      } catch (error) {
        throwIfAborted(input.signal);
        // Never feed a possibly credential-bearing raw cause back to the model.
        return { content: "Audio processing could not complete. Check Audio tools settings and this Session's saved audio jobs before retrying. No Live changes were performed by this tool.", failed: true, stop: true };
      }
    },
  };
}
