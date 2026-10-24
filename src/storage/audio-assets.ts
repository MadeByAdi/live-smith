import { createHash } from "node:crypto";
import { openVerifiedFileStream, type SessionFileExport } from "./file-export.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual, types } from "node:util";

import { inspectAudioAttachment } from "../attachments/audio.js";
import {
  AUDIO_OUTPUT_LABELS, MAX_AUDIO_ASSET_BYTES, MAX_AUDIO_SESSION_BYTES, MAX_AUDIO_JOB_OUTPUTS,
  type AudioAsset, type AudioJob, type AudioJobAssetRole, type AudioOrigin,
} from "../audio-services/contracts.js";
import { allocateArtifactVersion, artifactVersion } from "../agent/artifact-contracts.js";
import { audioOutputDescriptor, audioArtifactOutputDescriptor, audioOutputsCanShareWork } from "../audio-services/audio-output.js";
import { listPluginAudioArtifactRecords } from "./audio-artifacts.js";
import { storedSessionAudioBytes } from "./audio-storage-budget.js";
import { cloneJsonValue } from "../model/json-clone.js";
import { throwIfAborted } from "../runtime/host.js";
import { isMissingFileError } from "./errors.js";
import { createStorageId, isSafeStorageId, requireSafeStorageId } from "./id.js";
import {
  removeDirectoryDurably, withStorageTransaction,
  writeBytesAtomicallyCreateOnly, writeJsonAtomicallyCreateOnly,
} from "./persistence.js";
import {
  AudioStorageError, MAX_AUDIO_ASSET_METADATA_BYTES, assertAudioDirectory,
  assertAudioJsonSize, audioAssetId, audioAssetInspectionLimits,
  audioDirectoryEntries, audioJobOwnsAssetRole, audioRecordHasOnly, bindAudioDirectory, isAudioAsset,
  listAudioJobs, loadAudioJob, readAudioAssetRecord, readBoundedAudioFile,
  requireAudioSession, requireAudioStorage, type AudioDirectoryBinding,
} from "./audio-jobs.js";

export async function saveAudioAsset(
  storageDirectory: string | undefined,
  sessionId: string,
  input: { jobId: string; label: string; role: AudioJobAssetRole; bytes: Uint8Array; origin: AudioOrigin; signal: AbortSignal },
): Promise<AudioAsset> {
  requireAudioStorage(storageDirectory, sessionId);
  requireSafeStorageId(input.jobId, "Audio job ID");
  throwIfAborted(input.signal);
  if (!audioRecordHasOnly(input, ["jobId", "label", "role", "bytes", "origin", "signal"]) ||
    !types.isUint8Array(input.bytes) || input.bytes.byteLength > MAX_AUDIO_ASSET_BYTES) {
    throw new AudioStorageError("Audio assets must be valid audio of at most 128 MiB.");
  }
  const bytes = new Uint8Array(input.bytes);
  const origin = cloneJsonValue(input.origin);
  const { jobId, role, label, signal } = input;
  const inspection = await inspectAudioAttachment({ bytes, signal, limits: audioAssetInspectionLimits });
  const asset: AudioAsset = {
    id: audioAssetId(jobId, role), sessionId, jobId, role, label, origin,
    byteLength: bytes.byteLength, sha256: hashBytes(bytes), ...inspection,
  };
  if (!isAudioAsset(asset)) throw new AudioStorageError("Audio asset metadata is invalid.");
  assertAudioJsonSize(asset, MAX_AUDIO_ASSET_METADATA_BYTES);
  return withStorageTransaction(storageDirectory, async (transaction) => {
    throwIfAborted(signal);
    await requireAudioSession(storageDirectory, sessionId, transaction);
    const job = await loadAudioJob(storageDirectory, sessionId, jobId);
    if (!audioJobOwnsAssetRole(job, role)) throw new AudioStorageError("The audio output is not part of this job.");
    const directory = (await bindAudioDirectory(storageDirectory, sessionId))!;
    const [audioRecords, pluginRecords] = await Promise.all([
      listAudioAssetRecords(storageDirectory, sessionId), listPluginAudioArtifactRecords(storageDirectory, sessionId),
    ]);
    const records = [...audioRecords, ...pluginRecords];
    const selected = job.artifactSource?.kind === "audio" ? records.find((entry) => entry.id === job.artifactSource!.id) : undefined;
    if (job.artifactSource?.kind === "audio" && !selected) throw new AudioStorageError("The selected audio source is unavailable in this Session.");
    if (role !== "source" && origin.kind === "generated" && selected) asset.origin = { ...origin, sourceAssetId: selected.id };
    if (asset.origin.sourceAssetId !== undefined && !records.some((entry) => entry.id === asset.origin.sourceAssetId)) throw new AudioStorageError();
    const existing = audioRecords.find((entry) => entry.id === asset.id);
    if (existing) {
      // Exact retries retain the original allocation, including unversioned history.
      if (existing.version) asset.version = { ...existing.version };
    } else if (role !== "source") {
      const descriptor = audioOutputDescriptor(role)!;
      const isWork = descriptor.kind === "music" || descriptor.kind === "sound_effect";
      const sourceGroup = selected && artifactVersion(selected).groupId;
      const revisionOf = isWork && selected && records.filter((entry) => artifactVersion(entry).groupId === sourceGroup)
        .every((entry) => audioOutputsCanShareWork(descriptor, audioArtifactOutputDescriptor(entry))) ? selected.id : undefined;
      const sibling = isWork ? records.find((entry) => "jobId" in entry && entry.jobId === job.id &&
        audioOutputDescriptor(entry.role)?.kind === descriptor.kind) : undefined;
      asset.version = allocateArtifactVersion(asset.id, records, {
        ...(revisionOf ? { revisionOf } : {}), ...(sibling ? { groupWith: sibling.id } : {}),
      });
    }
    if (!isAudioAsset(asset)) throw new AudioStorageError("Audio asset metadata is invalid.");
    assertAudioJsonSize(asset, MAX_AUDIO_ASSET_METADATA_BYTES);
    if (existing && !isDeepStrictEqual(existing, asset)) throw new AudioStorageError("The saved audio asset differs from this retry.");
    const blobExists = await hasAudioBlob(directory, asset);
    if (blobExists) await readVerifiedBytes(directory, asset, signal);
    if (existing && blobExists) return existing;
    const usedBytes = await storedSessionAudioBytes(storageDirectory, sessionId);
    if (usedBytes + (blobExists ? 0 : asset.byteLength) > MAX_AUDIO_SESSION_BYTES) {
      throw new AudioStorageError("This Session has reached its 1 GiB audio storage limit.");
    }
    throwIfAborted(signal);
    await assertAudioDirectory(directory);
    // Commit the immutable recovery receipt first. A crash after the blob commit
    // can then recover without a provider response or another paid request.
    // A receipt without its complete blob is never listed as an available asset.
    if (!existing) await writeJsonAtomicallyCreateOnly(path.join(directory.directory, `${asset.id}.asset.json`), asset);
    await assertAudioDirectory(directory);
    if (!blobExists) await writeBytesAtomicallyCreateOnly(path.join(directory.directory, `${asset.id}.audio`), bytes);
    await assertAudioDirectory(directory);
    return asset;
  });
}

/**
 * Persists an already verified, bounded pre-FX Arrangement render for use by
 * approved local audio-artifact Plugin tools. This is deliberately not an
 * audio job: no provider request, remote task, or generated output exists.
 */
export async function saveArrangementAudioArtifact(
  storageDirectory: string | undefined,
  sessionId: string,
  input: { label: string; bytes: Uint8Array; origin: AudioOrigin; signal: AbortSignal },
): Promise<AudioAsset> {
  requireAudioStorage(storageDirectory, sessionId);
  throwIfAborted(input.signal);
  if (!audioRecordHasOnly(input, ["label", "bytes", "origin", "signal"]) ||
    !types.isUint8Array(input.bytes) || input.bytes.byteLength > MAX_AUDIO_ASSET_BYTES ||
    input.origin.kind !== "arrangement") {
    throw new AudioStorageError("Arrangement audio artifacts must be valid bounded Arrangement audio.");
  }
  const bytes = new Uint8Array(input.bytes);
  const origin = cloneJsonValue(input.origin);
  const inspection = await inspectAudioAttachment({ bytes, signal: input.signal, limits: audioAssetInspectionLimits });
  const asset: AudioAsset = {
    id: createStorageId("audio_artifact"), sessionId, role: "arrangement_render",
    label: input.label, origin, byteLength: bytes.byteLength, sha256: hashBytes(bytes), ...inspection,
  };
  if (!isAudioAsset(asset)) throw new AudioStorageError("Audio artifact metadata is invalid.");
  assertAudioJsonSize(asset, MAX_AUDIO_ASSET_METADATA_BYTES);
  return withStorageTransaction(storageDirectory, async (transaction) => {
    throwIfAborted(input.signal);
    await requireAudioSession(storageDirectory, sessionId, transaction);
    const directory = (await bindAudioDirectory(storageDirectory, sessionId, true))!;
    const usedBytes = await storedSessionAudioBytes(storageDirectory, sessionId);
    if (usedBytes + asset.byteLength > MAX_AUDIO_SESSION_BYTES) {
      throw new AudioStorageError("This Session has reached its 1 GiB audio storage limit.");
    }
    await assertAudioDirectory(directory);
    await writeJsonAtomicallyCreateOnly(path.join(directory.directory, `${asset.id}.asset.json`), asset);
    await assertAudioDirectory(directory);
    await writeBytesAtomicallyCreateOnly(path.join(directory.directory, `${asset.id}.audio`), bytes);
    await assertAudioDirectory(directory);
    return asset;
  });
}

/**
 * R&D-only ingress for a finalized stereo Main capture produced by the
 * unchanged upstream AgentAudioTap.  The caller owns the command protocol;
 * this boundary only admits immutable verified bytes into the Session store.
 */
export async function saveAgentAudioTapArtifact(
  storageDirectory: string | undefined,
  sessionId: string,
  input: { label: string; bytes: Uint8Array; captureId: string; origin?: AudioOrigin; signal: AbortSignal; minimumDurationSeconds?: number },
): Promise<AudioAsset> {
  requireAudioStorage(storageDirectory, sessionId);
  requireSafeStorageId(input.captureId, "AgentAudioTap capture ID");
  throwIfAborted(input.signal);
  if (!audioRecordHasOnly(input, ["label", "bytes", "captureId", "origin", "signal", "minimumDurationSeconds"]) ||
      !types.isUint8Array(input.bytes) || input.bytes.byteLength > MAX_AUDIO_ASSET_BYTES) {
    throw new AudioStorageError("AgentAudioTap artifacts must be valid bounded audio.");
  }
  if (input.minimumDurationSeconds !== undefined &&
    (!Number.isFinite(input.minimumDurationSeconds) || input.minimumDurationSeconds < 0 || input.minimumDurationSeconds > 60)) {
    throw new AudioStorageError("AgentAudioTap minimum duration is invalid.");
  }
  const bytes = new Uint8Array(input.bytes);
  const inspection = await inspectAudioAttachment({ bytes, signal: input.signal, limits: audioAssetInspectionLimits });
  if (inspection.channels !== 2) throw new AudioStorageError("AgentAudioTap Main captures must be stereo.");
  if (input.minimumDurationSeconds !== undefined && inspection.durationSeconds < input.minimumDurationSeconds) {
    throw new AudioStorageError("AgentAudioTap capture is too short for the requested Arrangement window.");
  }
  const asset: AudioAsset = {
    id: createStorageId("audio_artifact"), sessionId, role: "agent_audio_tap",
    label: input.label, origin: input.origin ?? { kind: "agent_audio_tap", captureId: input.captureId,
      scope: "main", tapPosition: "main_insertion_point" },
    byteLength: bytes.byteLength, sha256: hashBytes(bytes), ...inspection,
  };
  if (!isAudioAsset(asset)) throw new AudioStorageError("AgentAudioTap artifact metadata is invalid.");
  assertAudioJsonSize(asset, MAX_AUDIO_ASSET_METADATA_BYTES);
  return withStorageTransaction(storageDirectory, async (transaction) => {
    await requireAudioSession(storageDirectory, sessionId, transaction);
    const directory = (await bindAudioDirectory(storageDirectory, sessionId, true))!;
    if (await storedAudioBytes(directory) + asset.byteLength > MAX_AUDIO_SESSION_BYTES) {
      throw new AudioStorageError("This Session has reached its 1 GiB audio storage limit.");
    }
    await assertAudioDirectory(directory);
    await writeJsonAtomicallyCreateOnly(path.join(directory.directory, `${asset.id}.asset.json`), asset);
    await assertAudioDirectory(directory);
    await writeBytesAtomicallyCreateOnly(path.join(directory.directory, `${asset.id}.audio`), bytes);
    await assertAudioDirectory(directory);
    return asset;
  });
}

/**
 * Called while the app owns the complete same-Session send/command fence. The
 * checked budget therefore cannot be consumed by another supported Session
 * operation before this request saves its results. File writes recheck quota.
 */
export async function assertAudioOutputCapacity(
  storageDirectory: string | undefined, sessionId: string, outputCount: number,
): Promise<void> {
  requireAudioStorage(storageDirectory, sessionId);
  if (!Number.isInteger(outputCount) || outputCount < 1 || outputCount > MAX_AUDIO_JOB_OUTPUTS) throw new AudioStorageError("Invalid audio output capacity request.");
  await withStorageTransaction(storageDirectory, async () => {
    await requireAudioSession(storageDirectory, sessionId);
    const used = await storedSessionAudioBytes(storageDirectory, sessionId);
    if (used + outputCount * MAX_AUDIO_ASSET_BYTES > MAX_AUDIO_SESSION_BYTES) {
      throw new AudioStorageError("Insufficient audio output capacity within this Session's 1 GiB storage limit. No paid request was submitted.");
    }
  });
}

export async function readAudioAsset(
  storageDirectory: string | undefined,
  sessionId: string,
  assetId: string,
  signal?: AbortSignal,
): Promise<{ asset: AudioAsset; bytes: Uint8Array }> {
  requireAudioStorage(storageDirectory, sessionId);
  requireSafeStorageId(assetId, "Audio asset ID");
  throwIfAborted(signal);
  await requireAudioSession(storageDirectory, sessionId);
  const directory = await bindAudioDirectory(storageDirectory, sessionId);
  const asset = directory && await readAudioAssetRecord(directory, sessionId, assetId);
  if (!asset || !directory) throw new AudioStorageError("The audio asset does not exist in this Session.");
  if (asset.role !== "arrangement_render" && asset.role !== "agent_audio_tap") {
    if (!asset.jobId) throw new AudioStorageError();
    const job = await loadAudioJob(storageDirectory, sessionId, asset.jobId);
    if (!audioJobOwnsAssetRole(job, asset.role)) throw new AudioStorageError();
  }
  const bytes = await readVerifiedBytes(directory, asset, signal);
  const afterRead = await readAudioAssetRecord(directory, sessionId, assetId);
  if (!isDeepStrictEqual(afterRead, asset)) throw new AudioStorageError();
  return { asset, bytes };
}

export async function readExpectedAudioAsset(
  storageDirectory: string | undefined,
  sessionId: string,
  expectedAsset: AudioAsset,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!isAudioAsset(expectedAsset) || expectedAsset.sessionId !== sessionId) throw new AudioStorageError();
  const expected = cloneJsonValue(expectedAsset);
  const result = await readAudioAsset(storageDirectory, sessionId, expected.id, signal);
  if (!isDeepStrictEqual(result.asset, expected)) throw new AudioStorageError("The audio source changed since it was selected.");
  return result.bytes;
}

export async function audioAssetExport(storageDirectory: string, sessionId: string, expected: AudioAsset): Promise<SessionFileExport> {
  requireAudioStorage(storageDirectory, sessionId); requireSafeStorageId(expected.id, "Audio asset ID");
  await requireAudioSession(storageDirectory, sessionId);
  const directory = await bindAudioDirectory(storageDirectory, sessionId);
  if (!directory || !isDeepStrictEqual(await readAudioAssetRecord(directory, sessionId, expected.id), expected)) throw new AudioStorageError();
  return { fileName: expected.label, mediaType: expected.mediaType, byteLength: expected.byteLength,
    open: signal => openVerifiedFileStream({ path: path.join(directory.directory, `${expected.id}.audio`), byteLength: expected.byteLength, sha256: expected.sha256, signal,
      assertCurrent: async () => {
        await assertAudioDirectory(directory);
        if (expected.role !== "arrangement_render" && expected.role !== "agent_audio_tap") {
          if (!expected.jobId || !audioJobOwnsAssetRole(await loadAudioJob(storageDirectory, sessionId, expected.jobId), expected.role)) throw new AudioStorageError();
        }
        if (!isDeepStrictEqual(await readAudioAssetRecord(directory, sessionId, expected.id), expected)) throw new AudioStorageError();
      } }),
  };
}

export async function listAudioAssets(
  storageDirectory: string | undefined,
  sessionId: string,
  jobId?: string,
): Promise<AudioAsset[]> {
  requireAudioStorage(storageDirectory, sessionId);
  if (jobId !== undefined) requireSafeStorageId(jobId, "Audio job ID");
  const jobs = jobId === undefined ? await listAudioJobs(storageDirectory, sessionId)
    : [await loadAudioJob(storageDirectory, sessionId, jobId)];
  return listAssetsForJobs(storageDirectory, sessionId, jobs, jobId !== undefined);
}

/** Lists only generic read-only Arrangement-render artifacts, never audio-job outputs. */
export async function listArrangementAudioArtifacts(
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<AudioAsset[]> {
  requireAudioStorage(storageDirectory, sessionId);
  await requireAudioSession(storageDirectory, sessionId);
  const directory = await bindAudioDirectory(storageDirectory, sessionId);
  if (!directory) return [];
  const artifacts: AudioAsset[] = [];
  for (const name of await audioDirectoryEntries(directory)) {
    if (!name.endsWith(".asset.json")) continue;
    const asset = await readAudioAssetRecord(directory, sessionId, name.slice(0, -11));
    if (asset?.role === "arrangement_render" && await hasAudioBlob(directory, asset)) artifacts.push(asset);
  }
  return artifacts.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Lists generic read-only Session artifacts that are deliberately outside the
 * audio-job model. They remain immutable, Session-bound, and verified before
 * any consumer resolves them.
 */
export async function listSessionAudioArtifacts(
  storageDirectory: string | undefined,
  sessionId: string,
): Promise<AudioAsset[]> {
  requireAudioStorage(storageDirectory, sessionId);
  await requireAudioSession(storageDirectory, sessionId);
  const directory = await bindAudioDirectory(storageDirectory, sessionId);
  if (!directory) return [];
  const artifacts: AudioAsset[] = [];
  for (const name of await audioDirectoryEntries(directory)) {
    if (!name.endsWith(".asset.json")) continue;
    const asset = await readAudioAssetRecord(directory, sessionId, name.slice(0, -11));
    if ((asset?.role === "arrangement_render" || asset?.role === "agent_audio_tap") &&
      await hasAudioBlob(directory, asset)) artifacts.push(asset);
  }
  return artifacts.sort((a, b) => a.id.localeCompare(b.id));
}

/** One verified snapshot for callers that need both jobs and recoverable assets. */
export async function readAudioSessionState(
  storageDirectory: string, sessionId: string,
): Promise<{ jobs: AudioJob[]; assets: AudioAsset[] }> {
  const jobs = await listAudioJobs(storageDirectory, sessionId);
  return { jobs, assets: await listAssetsForJobs(storageDirectory, sessionId, jobs) };
}

async function listAssetsForJobs(
  storageDirectory: string, sessionId: string, jobs: readonly AudioJob[], oneJob = false,
): Promise<AudioAsset[]> {
  const directory = await bindAudioDirectory(storageDirectory, sessionId);
  if (!directory) return [];
  const byJobId = new Map(jobs.map((job) => [job.id, job]));
  const committed = new Map(jobs.flatMap((job) => job.outputAssets).map((asset) => [asset.id, asset]));
  const target = oneJob ? jobs[0]! : undefined;
  const wanted = target ? new Set(["source", ...Object.keys(AUDIO_OUTPUT_LABELS)]
    .map((role) => audioAssetId(target.id, role as AudioJobAssetRole))) : undefined;
  const assets: AudioAsset[] = [];
  for (const name of await audioDirectoryEntries(directory)) {
    if (!name.endsWith(".asset.json")) continue;
    const id = name.slice(0, -11);
    if (wanted && !wanted.has(id)) continue;
    // Job loading already verified committed metadata against the job snapshot.
    const asset = committed.get(id) ?? await readAudioAssetRecord(directory, sessionId, id);
    if (asset?.role === "arrangement_render" || asset?.role === "agent_audio_tap") continue;
    const job = asset?.jobId === undefined ? undefined : byJobId.get(asset.jobId);
    if (!asset || !job || !audioJobOwnsAssetRole(job, asset.role)) throw new AudioStorageError();
    if (await hasAudioBlob(directory, asset)) assets.push(asset);
  }
  return assets.sort((a, b) => a.id.localeCompare(b.id));
}

async function hasAudioBlob(directory: AudioDirectoryBinding, asset: AudioAsset): Promise<boolean> {
  let info;
  try { info = await fs.lstat(path.join(directory.directory, `${asset.id}.audio`)); }
  catch (error) { if (isMissingFileError(error)) return false; throw new AudioStorageError(); }
  if (!info.isFile() || info.isSymbolicLink() || info.size !== asset.byteLength) throw new AudioStorageError();
  await assertAudioDirectory(directory);
  return true;
}

export async function deleteSessionAudio(storageDirectory: string | undefined, sessionId: string): Promise<void> {
  requireSafeStorageId(sessionId, "Session ID");
  if (storageDirectory === undefined) return;
  requireAudioStorage(storageDirectory, sessionId);
  await withStorageTransaction(storageDirectory, async () => {
    const directory = await bindAudioDirectory(storageDirectory, sessionId);
    if (!directory) return;
    await assertAudioDirectory(directory);
    await removeDirectoryDurably(directory.directory);
  });
}

export async function listSessionAudioDirectoryIds(storageDirectory: string | undefined): Promise<string[]> {
  if (storageDirectory === undefined) return [];
  requireAudioStorage(storageDirectory, "startup");
  const root = path.join(storageDirectory, "live-smith-audio");
  let before;
  try { before = await fs.lstat(root); } catch (error) {
    if (isMissingFileError(error)) return [];
    throw new AudioStorageError();
  }
  if (!before.isDirectory() || before.isSymbolicLink()) throw new AudioStorageError();
  const ids: string[] = [];
  const directory = await fs.opendir(root);
  for await (const entry of directory) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !isSafeStorageId(entry.name)) throw new AudioStorageError();
    ids.push(entry.name);
  }
  const after = await fs.lstat(root);
  if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) throw new AudioStorageError();
  return ids.sort();
}

async function readVerifiedBytes(directory: AudioDirectoryBinding, asset: AudioAsset, signal?: AbortSignal): Promise<Uint8Array> {
  const bytes = await readBoundedAudioFile(directory, `${asset.id}.audio`, asset.byteLength, signal);
  if (bytes.byteLength !== asset.byteLength || hashBytes(bytes) !== asset.sha256) throw new AudioStorageError();
  const inspection = await inspectAudioAttachment({ bytes, limits: audioAssetInspectionLimits, ...(signal ? { signal } : {}) });
  if (inspection.mediaType !== asset.mediaType || inspection.durationSeconds !== asset.durationSeconds ||
    inspection.sampleRate !== asset.sampleRate || inspection.channels !== asset.channels) throw new AudioStorageError();
  return bytes;
}

/** Immutable metadata receipts also reserve versions when their blob commit was interrupted. */
export async function listAudioAssetRecords(storageDirectory: string, sessionId: string): Promise<AudioAsset[]> {
  const directory = await bindAudioDirectory(storageDirectory, sessionId);
  if (!directory) return [];
  const records: AudioAsset[] = [];
  for (const name of await audioDirectoryEntries(directory)) {
    if (!name.endsWith(".asset.json")) continue;
    const asset = await readAudioAssetRecord(directory, sessionId, name.slice(0, -11));
    if (asset) records.push(asset);
  }
  return records;
}

export async function storedAudioAssetBytes(storageDirectory: string, sessionId: string): Promise<number> {
  const directory = await bindAudioDirectory(storageDirectory, sessionId);
  return directory ? storedAudioBytes(directory) : 0;
}

async function storedAudioBytes(directory: AudioDirectoryBinding): Promise<number> {
  let bytes = 0;
  for (const name of await audioDirectoryEntries(directory)) {
    // Include interrupted atomic blob writes, as well as metadata-less blobs.
    const temporaryId = /^\.asset_[a-f0-9]{64}\.audio\.(tmp_.*)$/s.exec(name)?.[1];
    const isTemporary = temporaryId !== undefined;
    if (!name.endsWith(".audio") && !isTemporary) continue;
    if (isTemporary
      ? !isSafeStorageId(temporaryId) || temporaryId.length <= 4
      : !isSafeStorageId(name.slice(0, -6))) throw new AudioStorageError();
    const info = await fs.lstat(path.join(directory.directory, name));
    // A crash after opening the atomic temporary file can leave it empty.
    // Committed blobs must still contain audio, including metadata-less blobs.
    if (!info.isFile() || info.isSymbolicLink() ||
      info.size < (isTemporary ? 0 : 1) || info.size > MAX_AUDIO_ASSET_BYTES) throw new AudioStorageError();
    bytes += info.size;
  }
  await assertAudioDirectory(directory);
  return bytes;
}

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
