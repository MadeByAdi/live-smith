/** Host-owned audio processing contracts, independent of chat providers and Live. */
export const SEPARATION_STEMS = [
  "vocals", "drums", "bass", "piano", "electric_guitar", "acoustic_guitar",
] as const;
export type SeparationStem = (typeof SEPARATION_STEMS)[number];

export const MAX_AUDIO_ASSET_BYTES = 128 * 1024 * 1024;
export const MAX_AUDIO_ASSET_DURATION_SECONDS = 15 * 60;
export const MAX_AUDIO_JOB_OUTPUTS = 7;
export const MAX_AUDIO_SESSION_BYTES = 1024 * 1024 * 1024;
export const MAX_AUDIO_SESSION_JOBS = 40;
export const MAX_AUDIO_SERVICES = 20;
export const LEGACY_AUDIO_SERVICE_ID = "audio-service-lalal";
export const AUDIO_PROVIDERS = ["lalal", "elevenlabs", "suno", "sunoapi"] as const;
export type AudioProvider = (typeof AUDIO_PROVIDERS)[number];
export type AudioOperation = "separate_stems" | "generate_music" | "generate_sound_effect";

export interface AudioServiceConnection {
  id: string;
  name: string;
  provider: AudioProvider;
  enabled: boolean;
  apiKey: string;
  /** A provider model identifier; absent uses the adapter's documented default. */
  modelId?: string;
  /** User-owned public callback endpoint required by task-based providers. */
  callbackUrl?: string;
}

export interface AudioServicesSettings {
  connections: AudioServiceConnection[];
  revision: string;
}

export interface AudioServiceConnectionView extends Omit<AudioServiceConnection, "apiKey"> {
  apiKeyConfigured: boolean;
}

export interface AudioServicesView {
  connections: AudioServiceConnectionView[];
  revision: string;
}

export type AudioServicesSettingsPatch =
  | { action: "upsert"; expectedRevision: string; connection: Omit<AudioServiceConnection, "apiKey"> & { apiKey?: string } }
  | { action: "remove"; expectedRevision: string; serviceId: string };

export type AudioGenerationRequest =
  | { operation: "generate_music"; prompt: string; durationSeconds?: number; instrumental: boolean }
  | { operation: "generate_sound_effect"; prompt: string; durationSeconds: number; loop: boolean };

export interface GeneratedAudioOutput {
  role: "music" | "music_alternative" | "sound_effect";
  bytes: Uint8Array;
}

export type AudioGenerationSubmission =
  | { kind: "audio"; outputs: GeneratedAudioOutput[] }
  | { kind: "task"; taskId: string };

export interface AudioGenerationAdapter {
  readonly provider: "elevenlabs" | "suno" | "sunoapi";
  submit(request: AudioGenerationRequest, signal: AbortSignal): Promise<AudioGenerationSubmission>;
  inspect?(taskId: string, signal: AbortSignal): Promise<RemoteAudioStatus>;
  download?(output: RemoteAudioOutput, signal: AbortSignal): Promise<Uint8Array>;
  cancel?(taskId: string, signal: AbortSignal): Promise<void>;
}

export interface AudioOrigin {
  kind: "attachment" | "arrangement" | "asset" | "generated";
  /** Arrangement position of the rendered snapshot, not a live target binding. */
  startBeat?: number;
  endBeat?: number;
  tempo?: number;
  sourceAssetId?: string;
}

export interface AudioAsset {
  id: string;
  sessionId: string;
  jobId: string;
  label: string;
  role: SeparationStem | "residual" | "source" | GeneratedAudioOutput["role"];
  mediaType: "audio/wav" | "audio/mpeg";
  byteLength: number;
  sha256: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  origin: AudioOrigin;
}

/** Protocol-owned locator. Never projected into model messages or browser state. */
export interface RemoteAudioOutput {
  key: string;
  role: SeparationStem | "residual" | GeneratedAudioOutput["role"];
  url: string;
}

export type RemoteAudioStatus =
  | { status: "running"; progress?: number }
  | { status: "completed"; outputs: RemoteAudioOutput[] }
  | { status: "failed"; message: string }
  | { status: "cancelled" };

/** Only methods supported by the implemented asynchronous service are required. */
export interface AudioServiceAdapter {
  readonly provider: "lalal";
  readonly stems: readonly SeparationStem[];
  upload(bytes: Uint8Array, mediaType: AudioAsset["mediaType"], signal: AbortSignal): Promise<string>;
  submit(sourceId: string, stems: readonly SeparationStem[], idempotencyKey: string, signal: AbortSignal): Promise<string>;
  inspect(taskId: string, stems: readonly SeparationStem[], signal: AbortSignal): Promise<RemoteAudioStatus>;
  cancel?(taskId: string, signal: AbortSignal): Promise<void>;
  download(output: RemoteAudioOutput, signal: AbortSignal): Promise<Uint8Array>;
}

export type AudioJobStatus =
  | "preparing" | "submitting" | "running" | "collecting"
  | "completed" | "partial" | "failed" | "interrupted" | "unknown" | "cancelled";

export interface AudioJob {
  id: string;
  sessionId: string;
  provider: AudioProvider;
  serviceId: string;
  modelId?: string;
  /** Fingerprint of the exact saved credential; no secret is stored here. */
  connectionFingerprint: string;
  operation: AudioOperation;
  stems: SeparationStem[];
  status: AudioJobStatus;
  createdAt: string;
  updatedAt: string;
  sourceAssetId?: string;
  remoteSourceId?: string;
  remoteTaskId?: string;
  /** Final result shape acknowledged before collecting task-based generation. */
  expectedOutputRoles?: GeneratedAudioOutput["role"][];
  outputAssets: AudioAsset[];
  message?: string;
}

export interface AudioJobView {
  id: string;
  provider: AudioProvider;
  serviceId: string;
  operation: AudioOperation;
  modelId?: string;
  status: AudioJobStatus;
  stems: SeparationStem[];
  createdAt: string;
  outputs: AudioAsset[];
  message?: string;
  resumable: boolean;
}

export function audioJobView(job: AudioJob): AudioJobView {
  return {
    id: job.id, status: job.status, stems: [...job.stems], createdAt: job.createdAt,
    provider: job.provider, serviceId: job.serviceId, operation: job.operation,
    ...(job.modelId ? { modelId: job.modelId } : {}),
    outputs: job.outputAssets.map((asset) => ({ ...asset, origin: { ...asset.origin } })),
    ...(job.message ? { message: job.message } : {}),
    resumable: Boolean(job.remoteTaskId) && job.status !== "completed" && job.status !== "cancelled",
  };
}
