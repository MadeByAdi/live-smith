import type { AudioOperation, AudioProvider, MusicGenerationOptionField } from "./contracts.js";

export const SUNOAPI_MUSIC_MODELS = [
  "V6", "V6_WILD", "V6_MINI", "V5_5", "V5", "V4_5PLUS", "V4_5ALL", "V4_5", "V4",
] as const;
export const DEFAULT_SUNOAPI_MUSIC_MODEL = "V6";
export const MUREKA_MUSIC_MODELS = [
  "auto", "mureka-7.6", "mureka-o2", "mureka-8", "mureka-9", "mureka-9.5",
] as const;
export const DEFAULT_MUREKA_MUSIC_MODEL = "auto";

/** Protocol capabilities, not chat-model name heuristics or user claims. */
export const AUDIO_SERVICE_CAPABILITIES: Record<AudioProvider, {
  label: string;
  operations: readonly AudioOperation[];
  musicDuration?: { minimumSeconds: number; maximumSeconds: number };
  generationOutputCount: number;
  musicPromptCharacters: number;
  /** Website authentication can be available before generation is supported. */
  sessionImport?: boolean;
  customMusic?: boolean;
  customMusicOptions?: readonly MusicGenerationOptionField[];
  requiredCustomMusicOptions?: readonly MusicGenerationOptionField[];
  musicLibrary?: boolean;
  modelConfigurable?: boolean;
  modelIds?: readonly string[];
  defaultModelId?: string;
  instrumentalUnsupportedModelIds?: readonly string[];
}> = {
  lalal: { label: "LALAL.AI", operations: ["separate_stems"], generationOutputCount: 0, musicPromptCharacters: 0 },
  elevenlabs: { label: "ElevenLabs", operations: ["generate_music", "generate_sound_effect"],
    musicDuration: { minimumSeconds: 3, maximumSeconds: 600 },
    generationOutputCount: 1, musicPromptCharacters: 4100, modelConfigurable: true },
  mureka: { label: "Mureka", operations: ["generate_music"], generationOutputCount: 1,
    musicPromptCharacters: 1024, modelIds: MUREKA_MUSIC_MODELS,
    defaultModelId: DEFAULT_MUREKA_MUSIC_MODEL, modelConfigurable: true,
    instrumentalUnsupportedModelIds: ["mureka-o2"] },
  "suno-platform": { label: "Suno Platform (official API)", operations: ["generate_music"],
    generationOutputCount: 1, musicPromptCharacters: 5000, customMusic: true,
    customMusicOptions: ["title", "styles", "personaId"], requiredCustomMusicOptions: ["styles"] },
  suno: { label: "Suno.com subscription (experimental)", operations: ["generate_music", "extend_music", "get_whole_song", "retrieve_music"],
    musicDuration: { minimumSeconds: 10, maximumSeconds: 480 },
    generationOutputCount: 2, musicPromptCharacters: 5000, sessionImport: true, customMusic: true,
    customMusicOptions: ["title", "styles", "negativeStyles", "weirdness", "styleInfluence", "vocalGender", "personaId"],
    musicLibrary: true, modelConfigurable: true },
  sunoapi: { label: "Suno via SunoAPI.org (third-party)", operations: ["generate_music"],
    generationOutputCount: 2, musicPromptCharacters: 3000, modelIds: SUNOAPI_MUSIC_MODELS,
    defaultModelId: DEFAULT_SUNOAPI_MUSIC_MODEL, modelConfigurable: true },
};

export function audioServiceSupports(provider: AudioProvider, operation: AudioOperation): boolean {
  return AUDIO_SERVICE_CAPABILITIES[provider].operations.includes(operation);
}

export interface AudioServiceChoice {
  id: string;
  name: string;
  provider: AudioProvider;
}
