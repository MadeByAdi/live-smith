import { setTimeout as delay } from "node:timers/promises";
import { setTimeout, clearTimeout } from "node:timers";
import type {
  AudioGenerationAdapter, AudioGenerationRequest, AudioJob,
  GeneratedAudioOutput,
} from "../audio-services/contracts.js";
import { AUDIO_SERVICE_CAPABILITIES } from "../audio-services/capabilities.js";
import { exceedsAudioPromptLimit } from "../audio-services/prompt.js";
import { AttachmentProcessingError } from "../attachments/contracts.js";
import { createElevenLabsAudioAdapter } from "../audio-services/elevenlabs.js";
import { createSunoApiAudioAdapter } from "../audio-services/sunoapi.js";
import { createSunoAudioAdapter } from "../audio-services/suno.js";
import { createHostAbortController, throwIfAborted, waitForPromiseWithSignal } from "../runtime/host.js";
import { createAudioJob, updateAudioJob } from "../storage/audio-jobs.js";
import { assertAudioOutputCapacity, saveAudioAsset } from "../storage/audio-assets.js";
import { acquireAudioJob, boundedAudioMessage, safeAudioFailure } from "./audio-job-runtime.js";
import { audioConnectionFingerprint, resolveAudioService, type RuntimeAudioServiceConnection } from "./audio-service-connections.js";
import type { AudioProcessingContext } from "./audio-processing.js";
import { providerFetchForStorage } from "./provider-fetch.js";

function generationAdapter(context: AudioProcessingContext, settings: RuntimeAudioServiceConnection): AudioGenerationAdapter {
  if (context.generationAdapter) {
    if (context.generationAdapter.provider !== settings.provider) throw new Error("Audio adapter does not match the selected connection.");
    return context.generationAdapter;
  }
  if (settings.provider === "elevenlabs") {
    return createElevenLabsAudioAdapter(settings.apiKey, {
      fetchImpl: providerFetchForStorage(context.storageDirectory),
      ...(settings.modelId ? { modelId: settings.modelId } : {}),
    });
  }
  if (settings.provider === "sunoapi" && settings.callbackUrl) {
    return createSunoApiAudioAdapter(settings.apiKey, {
      fetchImpl: providerFetchForStorage(context.storageDirectory), callbackUrl: settings.callbackUrl,
      ...(settings.modelId ? { modelId: settings.modelId } : {}),
    });
  }
  if (settings.provider === "suno" && settings.sunoSession) {
    return createSunoAudioAdapter(settings.sunoSession, {
      fetchImpl: providerFetchForStorage(context.storageDirectory),
      ...(settings.modelId ? { modelId: settings.modelId } : {}),
    });
  }
  throw new Error("This service's generation protocol is not available.");
}

export async function generateAudio(
  context: AudioProcessingContext, serviceId: string, request: AudioGenerationRequest,
): Promise<AudioJob> {
  throwIfAborted(context.signal);
  const settings = await resolveAudioService(context.storageDirectory, serviceId, request.operation, context.admittedConnections);
  if ((request.operation === "generate_music" || request.operation === "extend_music") && request.options &&
    !AUDIO_SERVICE_CAPABILITIES[settings.provider].customMusic) throw new Error("This service does not support custom music parameters.");
  if (request.operation === "generate_music" && exceedsAudioPromptLimit(request.prompt, AUDIO_SERVICE_CAPABILITIES[settings.provider].musicPromptCharacters)) {
    throw new Error("The music prompt exceeds this service's supported limit.");
  }
  if (request.operation === "generate_music" && request.durationSeconds !== undefined &&
    !AUDIO_SERVICE_CAPABILITIES[settings.provider].musicDuration) {
    throw new Error("This service does not support an explicit music duration.");
  }
  const adapter = generationAdapter(context, settings);
  await assertAudioOutputCapacity(context.storageDirectory, context.sessionId,
    request.operation === "get_whole_song" ? 1 : AUDIO_SERVICE_CAPABILITIES[settings.provider].generationOutputCount);
  const job = await createAudioJob(context.storageDirectory, context.sessionId, {
    provider: settings.provider, serviceId: settings.id, operation: request.operation,
    ...(request.operation !== "generate_sound_effect" && settings.modelId ? { modelId: settings.modelId } : {}),
    connectionFingerprint: audioConnectionFingerprint(settings), stems: [],
  });
  const release = acquireAudioJob(context.storageDirectory, job.id);
  try { return await runGeneration(context, job, settings, adapter, request); }
  finally { release(); }
}

export async function resumeAudioGeneration(context: AudioProcessingContext, job: AudioJob): Promise<AudioJob> {
  const settings = await resolveAudioService(context.storageDirectory, job.serviceId, job.operation);
  if (settings.provider !== job.provider || audioConnectionFingerprint(settings) !== job.connectionFingerprint) {
    throw new Error("This audio job belongs to a different service connection. Restore that connection to retrieve it.");
  }
  const { modelId: _currentModel, ...connection } = settings;
  const adapter = generationAdapter(context, { ...connection, ...(job.modelId ? { modelId: job.modelId } : {}) });
  return runGeneration(context, job, settings, adapter);
}

async function runGeneration(
  context: AudioProcessingContext, initial: AudioJob, settings: RuntimeAudioServiceConnection,
  adapter: AudioGenerationAdapter, request?: AudioGenerationRequest,
): Promise<AudioJob> {
  let job = initial;
  let acceptedTaskId = initial.remoteTaskId;
  let acceptedOutputs = initial.expectedOutputs;
  let hasCompleteAudio = false;
  let submissionStarted = false;
  const update = async (patch: Parameters<typeof updateAudioJob>[3]) => {
    job = await updateAudioJob(context.storageDirectory, context.sessionId, job.id, patch);
  };
  const save = async (output: GeneratedAudioOutput, preserveCompleted = false) => {
    if (job.outputAssets.some((asset) => asset.role === output.role)) return;
    const persist = () => saveAudioAsset(context.storageDirectory, context.sessionId, {
      jobId: job.id, role: output.role,
      label: output.role === "sound_effect" ? "Sound effect" : output.role === "music_alternative" ? "Music alternative" : "Music",
      bytes: output.bytes, origin: { kind: "generated" },
      // A complete paid result may race Stop. Persist that result, without
      // authorizing another remote request or a Live mutation.
      signal: preserveCompleted ? createHostAbortController().signal : context.signal,
    });
    const asset = preserveCompleted ? await retryLocalCommit(persist) : await persist();
    await retryLocalCommit(() => update({ outputAssets: [...job.outputAssets, asset] }));
  };
  try {
    if (request) {
      await context.onProgress?.(request.operation === "generate_sound_effect" ? "Generating a sound effect" : "Preparing music generation");
      throwIfAborted(context.signal);
      await adapter.prepare?.(request, context.signal);
      await update({ status: "submitting", message: "Waiting for the audio service. Do not submit duplicates." });
      await resolveAudioService(context.storageDirectory, settings.id, request.operation, [settings]);
      throwIfAborted(context.signal);
      submissionStarted = true;
      const result = await adapter.submit(request, context.signal);
      if (result.kind === "audio") {
        hasCompleteAudio = true;
        for (const output of result.outputs) await save(output, true);
        if (!job.outputAssets.length) throw new Error("The audio service returned no usable output.");
        await retryLocalCommit(() => update({ status: "completed", message: "Generated audio is saved. Importing it into Live is a separate scoped Apply operation." }));
        return job;
      }
      acceptedTaskId = result.taskId;
      acceptedOutputs = result.expectedOutputs;
      await retryLocalCommit(() => update({ remoteTaskId: result.taskId,
        ...(acceptedOutputs ? { expectedOutputs: acceptedOutputs } : {}), status: "running" }));
    }
    throwIfAborted(context.signal);
    if (!acceptedTaskId || !adapter.inspect || !adapter.download) {
      throw new Error("This generation has no resumable remote task. It will not be submitted again automatically.");
    }
    const deadline = Date.now() + 30 * 60_000;
    for (;;) {
      throwIfAborted(context.signal);
      const remote = await adapter.inspect(acceptedTaskId, context.signal, acceptedOutputs);
      if (remote.status === "failed" || remote.status === "cancelled") {
        await update({ status: remote.status === "cancelled" ? "cancelled" : job.outputAssets.length ? "partial" : "failed",
          message: remote.status === "failed" ? remote.message : "The audio service confirmed cancellation." });
        return job;
      }
      if (remote.status === "completed") {
        const roles = (job.expectedOutputs ?? remote.outputs).map((output) => output.role);
        if (roles.some((role) => !["music", "music_alternative", "sound_effect"].includes(role))) throw new Error("Unexpected generated audio role.");
        if (!job.expectedOutputs && job.outputAssets.length) {
          throw new Error("This historical partial result has no saved remote output identities. Existing audio is retained, but missing files cannot be safely matched.");
        }
        const expectedOutputs = job.expectedOutputs ?? remote.outputs.map(({ key, role }) => ({ key, role: role as GeneratedAudioOutput["role"] }));
        const returned = new Set(remote.outputs.map((output) => output.key));
        const failed = remote.failedOutputKeys ?? [];
        if (returned.size !== remote.outputs.length || new Set(failed).size !== failed.length ||
          failed.some((key) => returned.has(key) || !expectedOutputs.some((output) => output.key === key)) ||
          remote.outputs.some((output) => !expectedOutputs.some((expected) => expected.key === output.key && expected.role === output.role)) ||
          expectedOutputs.some((output) => !returned.has(output.key) && !failed.includes(output.key))) {
          throw new Error("The confirmed audio output identities changed.");
        }
        acceptedOutputs = expectedOutputs;
        await retryLocalCommit(() => update({ status: "collecting", expectedOutputs }));
        const failures: string[] = failed.length ? ["The service failed to generate one or more confirmed outputs."] : [];
        for (const output of remote.outputs) {
          if (job.outputAssets.some((asset) => asset.role === output.role)) continue;
          throwIfAborted(context.signal);
          let bytes: Uint8Array;
          try { bytes = await adapter.download(output, context.signal); }
          catch (error) {
            throwIfAborted(context.signal);
            failures.push(`${output.role}: ${safeAudioFailure(error, settings.sunoSession?.clientToken ?? settings.apiKey)}`);
            continue;
          }
          try { await save({ role: output.role as GeneratedAudioOutput["role"], bytes }); }
          catch (error) {
            throwIfAborted(context.signal);
            if (!(error instanceof AttachmentProcessingError)) throw error;
            failures.push(`${output.role}: ${safeAudioFailure(error, settings.sunoSession?.clientToken ?? settings.apiKey)}`);
          }
        }
        const missing = roles.filter((role) => !job.outputAssets.some((asset) => asset.role === role));
        await retryLocalCommit(() => update({ status: missing.length ? job.outputAssets.length ? "partial" : "interrupted" : "completed",
          message: missing.length
            ? boundedAudioMessage(`Generated audio is not fully saved. Resume to retrieve missing files without another generation. ${failures.join("; ")}`)
            : "Generated audio is saved. Importing it into Live is a separate scoped Apply operation." }));
        return job;
      }
      await context.onProgress?.("Waiting for generated audio");
      if (Date.now() >= deadline) {
        await update({ status: "interrupted", message: "Stopped waiting. Resume this job to check its existing remote task." });
        return job;
      }
      if (context.wait) await context.wait(context.signal);
      else await delay(3_000, undefined, { signal: context.signal });
    }
  } catch (error) {
    let recordingFailure: unknown;
    try {
      await update({
        ...(acceptedTaskId ? { remoteTaskId: acceptedTaskId } : {}),
        ...(acceptedOutputs ? { expectedOutputs: acceptedOutputs } : {}),
        status: job.outputAssets.length ? "partial" : acceptedTaskId || hasCompleteAudio ? "interrupted"
          : submissionStarted || initial.status === "submitting" || initial.status === "unknown" ? "unknown"
          : context.signal.aborted ? "interrupted" : "failed",
        message: context.signal.aborted
          ? "Local audio generation stopped. This does not confirm service-side cancellation or a credit refund. No automatic resubmission will occur."
          : safeAudioFailure(error, settings.sunoSession?.clientToken ?? settings.apiKey),
      });
    } catch (failure) { recordingFailure = failure; }
    finally {
      if ((context.signal.aborted || recordingFailure) && acceptedTaskId && adapter.cancel) {
        const controller = createHostAbortController();
        const timer = setTimeout(() => controller.abort(), 3_000);
        try { await waitForPromiseWithSignal(adapter.cancel(acceptedTaskId, controller.signal), controller.signal); }
        catch { /* A later status read is required to confirm remote cancellation. */ }
        finally { clearTimeout(timer); }
      }
    }
    if (recordingFailure) throw recordingFailure;
    throwIfAborted(context.signal);
    return job;
  }
}

async function retryLocalCommit<T>(commit: () => Promise<T>): Promise<T> {
  try { return await commit(); }
  catch {
    // Reconcile a one-time or unknown local commit using exactly the same
    // immutable receipt. This helper never wraps a provider request.
    return commit();
  }
}
