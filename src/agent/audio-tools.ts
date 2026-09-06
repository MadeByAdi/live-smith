import { SEPARATION_STEMS, type SeparationStem } from "../audio-services/contracts.js";
import { AUDIO_SERVICE_CAPABILITIES, audioServiceSupports, type AudioServiceChoice } from "../audio-services/capabilities.js";
import type { ModelFunctionTool } from "../model/provider.js";
import { isSafeStorageId } from "../storage/id.js";

export type AudioProcessingSource =
  | { kind: "request_audio_attachment"; requestId: string; audioIndex: number }
  | { kind: "audio_asset"; assetRef: string }
  | {
      kind: "arrangement_audio"; trackName?: string; clipName?: string;
      clipStartBeat?: number; startBeat: number; endBeat: number;
    };

export type AudioToolRequest =
  | { kind: "separate_stems"; serviceId: string; source: AudioProcessingSource; stems: SeparationStem[] }
  | { kind: "generate_music"; serviceId: string; prompt: string; durationSeconds?: number; instrumental: boolean }
  | { kind: "generate_sound_effect"; serviceId: string; prompt: string; durationSeconds: number; loop: boolean }
  | { kind: "list_audio_jobs" }
  | { kind: "resume_audio_job"; jobId: string };

const stringField = { type: "string", minLength: 1, maxLength: 128 };
const sourceSchema = {
  oneOf: [
    {
      type: "object", additionalProperties: false,
      properties: { kind: { const: "request_audio_attachment" }, requestId: stringField, audioIndex: { type: "integer", minimum: 0, maximum: 1 } },
      required: ["kind", "requestId", "audioIndex"],
    },
    {
      type: "object", additionalProperties: false,
      properties: { kind: { const: "audio_asset" }, assetRef: stringField },
      required: ["kind", "assetRef"],
    },
    {
      type: "object", additionalProperties: false,
      properties: {
        kind: { const: "arrangement_audio" }, trackName: stringField, clipName: stringField,
        clipStartBeat: { type: "number" }, startBeat: { type: "number" }, endBeat: { type: "number" },
      },
      required: ["kind", "startBeat", "endBeat"],
    },
  ],
};

export function audioProcessingTools(services: readonly AudioServiceChoice[]): ModelFunctionTool[] {
  const separation = services.filter((entry) => audioServiceSupports(entry.provider, "separate_stems"));
  return [
    ...(separation.length ? [{
      type: "function" as const,
      function: {
        name: "separate_stems",
        description: "Separate an exact audio source into selected instrument stems plus the residual mix. This uploads chosen audio and consumes processing minutes for each requested stem. Use only for the user's audio separation request. It saves local results without changing Live. Inspect Arrangement Clip state first; range must lie within one isolated Clip. Current attachment and saved asset locators come from host context. Long processing waits inside the tool; do not submit duplicates. " + describeServices(separation),
        parameters: {
          type: "object", additionalProperties: false,
          properties: { serviceId: serviceSchema(separation), source: sourceSchema, stems: { type: "array", minItems: 1, maxItems: SEPARATION_STEMS.length, uniqueItems: true, items: { type: "string", enum: [...SEPARATION_STEMS] } } },
          required: ["serviceId", "source", "stems"],
        },
      },
    }] : []),
    ...generationTools(services),
    ...(services.some((entry) => AUDIO_SERVICE_CAPABILITIES[entry.provider].operations.length) ? [{
      type: "function" as const,
      function: {
        name: "resume_audio_job",
        description: "Check an existing audio job using its original saved connection and retrieve missing outputs. Does not submit new processing or change Live. Use a jobId from list_audio_jobs. A job with unknown submission outcome and no remote ticket cannot be resumed.",
        parameters: { type: "object", properties: { jobId: stringField }, required: ["jobId"], additionalProperties: false },
      },
    }] : []),
    {
      type: "function",
      function: {
        name: "list_audio_jobs",
        description: "List this Session's saved audio processing jobs and verified result asset references, including previous requests. Results include snapshot origins, not permission to change Live. Use an output's id as assetRef in an audio_asset SampleSource or subsequent audio processing call. This only reads local state.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
  ];
}

function describeServices(services: readonly AudioServiceChoice[]): string {
  return "Available connections (IDs and user-defined labels): " + JSON.stringify(services);
}

function serviceSchema(services: readonly AudioServiceChoice[]) {
  return { type: "string", enum: services.map((entry) => entry.id) };
}

function generationTools(services: readonly AudioServiceChoice[]): ModelFunctionTool[] {
  return (["generate_music", "generate_sound_effect"] as const).flatMap((operation) => {
    const eligible = services.filter((entry) => audioServiceSupports(entry.provider, operation));
    if (!eligible.length) return [];
    const music = operation === "generate_music";
    return [{ type: "function" as const, function: {
      name: operation,
      description: (music ? "Generate original music from a description." : "Generate a sound effect from a description.") +
        " Uses the selected service's paid generation allowance. Only use for the user's requested generation; do not generate speculative variants. Saves audio results without changing Live. Do not repeat a call after an unknown outcome or retry on another account. " + describeServices(eligible),
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          serviceId: serviceSchema(eligible), prompt: { type: "string", minLength: 1, maxLength: 4100 },
          ...(!music || eligible.some((service) => AUDIO_SERVICE_CAPABILITIES[service.provider].musicDuration)
            ? { durationSeconds: { type: "number", minimum: music ? 3 : 0.5, maximum: music ? 600 : 30 } } : {}),
          ...(music ? { instrumental: { type: "boolean" } } : { loop: { type: "boolean" } }),
        },
        required: music ? ["serviceId", "prompt", "instrumental"] : ["serviceId", "prompt", "durationSeconds", "loop"],
        oneOf: eligible.map((service) => ({
          type: "object", additionalProperties: false,
          properties: {
            serviceId: { const: service.id }, prompt: { type: "string", minLength: 1,
              maxLength: music ? AUDIO_SERVICE_CAPABILITIES[service.provider].musicPromptCharacters : 4100 },
            ...(!music || AUDIO_SERVICE_CAPABILITIES[service.provider].musicDuration
              ? { durationSeconds: { type: "number", minimum: music ? 3 : 0.5, maximum: music ? 600 : 30 } } : {}),
            ...(music ? { instrumental: { type: "boolean" } } : { loop: { type: "boolean" } }),
          },
          required: music ? ["serviceId", "prompt", "instrumental"] : ["serviceId", "prompt", "durationSeconds", "loop"],
        })),
      },
    } }];
  });
}

export function validateAudioServiceRequest(request: AudioToolRequest, services: readonly AudioServiceChoice[]): void {
  if (request.kind === "list_audio_jobs" || request.kind === "resume_audio_job") return;
  const service = services.find((entry) => entry.id === request.serviceId);
  if (!service || !audioServiceSupports(service.provider, request.kind)) throw new Error("Unavailable audio connection or operation.");
  const capability = AUDIO_SERVICE_CAPABILITIES[service.provider];
  if (request.kind === "generate_music" && (request.prompt.length > capability.musicPromptCharacters ||
    (!capability.musicDuration && request.durationSeconds !== undefined))) {
    throw new Error("This connection does not support those music generation parameters.");
  }
}

export function parseAudioToolRequest(name: string, argumentsJson: string): AudioToolRequest {
  const args: unknown = JSON.parse(argumentsJson || "{}");
  if (name === "list_audio_jobs") {
    const value = record(args); only(value, []);
    return { kind: name };
  }
  if (name === "resume_audio_job") {
    const value = record(args); only(value, ["jobId"]);
    return { kind: name, jobId: id(value.jobId) };
  }
  if (name === "generate_music" || name === "generate_sound_effect") {
    const value = record(args);
    const music = name === "generate_music";
    only(value, ["serviceId", "prompt", "durationSeconds", music ? "instrumental" : "loop"]);
    if (typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 4100 || value.prompt.includes("\0")) {
      throw new Error("Audio generation needs a non-empty prompt of at most 4100 characters.");
    }
    const option = music ? value.instrumental : value.loop;
    if (typeof option !== "boolean") throw new Error("Invalid audio generation option.");
    const duration = value.durationSeconds === undefined && music ? undefined : number(value.durationSeconds);
    if (duration !== undefined && (duration < (music ? 3 : 0.5) || duration > (music ? 600 : 30))) {
      throw new Error("Audio generation duration is outside the supported range.");
    }
    return music
      ? { kind: name, serviceId: id(value.serviceId), prompt: value.prompt,
        ...(duration === undefined ? {} : { durationSeconds: duration }), instrumental: option }
      : { kind: name, serviceId: id(value.serviceId), prompt: value.prompt, durationSeconds: duration!, loop: option };
  }
  if (name !== "separate_stems") throw new Error("Unknown audio tool.");
  const value = record(args); only(value, ["serviceId", "source", "stems"]);
  if (!Array.isArray(value.stems) || value.stems.length < 1 || value.stems.length > SEPARATION_STEMS.length ||
    new Set(value.stems).size !== value.stems.length || value.stems.some((stem) => !SEPARATION_STEMS.includes(stem))) {
    throw new Error("stems must be a non-empty unique selection of the available stems.");
  }
  return { kind: name, serviceId: id(value.serviceId), stems: value.stems as SeparationStem[], source: parseSource(value.source) };
}

function parseSource(input: unknown): AudioProcessingSource {
  const source = record(input);
  if (source.kind === "audio_asset") {
    only(source, ["kind", "assetRef"]);
    return { kind: source.kind, assetRef: id(source.assetRef) };
  }
  if (source.kind === "request_audio_attachment") {
    only(source, ["kind", "requestId", "audioIndex"]);
    if (!Number.isInteger(source.audioIndex) || (source.audioIndex as number) < 0 || (source.audioIndex as number) > 1) throw new Error("Invalid audio attachment index.");
    return { kind: source.kind, requestId: id(source.requestId), audioIndex: source.audioIndex as number };
  }
  if (source.kind !== "arrangement_audio") throw new Error("Invalid audio source kind.");
  only(source, ["kind", "trackName", "clipName", "clipStartBeat", "startBeat", "endBeat"]);
  const startBeat = number(source.startBeat);
  const endBeat = number(source.endBeat);
  if (endBeat <= startBeat) throw new Error("Audio endBeat must be greater than startBeat.");
  return {
    kind: source.kind, startBeat, endBeat,
    ...(source.trackName === undefined ? {} : { trackName: text(source.trackName) }),
    ...(source.clipName === undefined ? {} : { clipName: text(source.clipName) }),
    ...(source.clipStartBeat === undefined ? {} : { clipStartBeat: number(source.clipStartBeat) }),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Audio tool arguments must be an object.");
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Audio tool arguments contain unsupported fields.");
}
function id(value: unknown): string {
  if (!isSafeStorageId(value)) throw new Error("Invalid audio reference.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 128) throw new Error("Invalid audio target name.");
  return value;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Audio beat positions must be finite numbers.");
  return value;
}
