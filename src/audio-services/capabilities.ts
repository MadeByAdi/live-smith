import type { AudioOperation, AudioProvider } from "./contracts.js";

/** Protocol capabilities, not chat-model name heuristics or user claims. */
export const AUDIO_SERVICE_CAPABILITIES: Record<AudioProvider, {
  label: string;
  operations: readonly AudioOperation[];
  musicDuration: boolean;
  generationOutputCount: number;
  musicPromptCharacters: number;
}> = {
  lalal: { label: "LALAL.AI", operations: ["separate_stems"], musicDuration: false, generationOutputCount: 0, musicPromptCharacters: 0 },
  elevenlabs: { label: "ElevenLabs", operations: ["generate_music", "generate_sound_effect"], musicDuration: true, generationOutputCount: 1, musicPromptCharacters: 4100 },
  suno: { label: "Suno", operations: [], musicDuration: false, generationOutputCount: 0, musicPromptCharacters: 0 },
  sunoapi: { label: "Suno via SunoAPI.org (third-party)", operations: ["generate_music"], musicDuration: false, generationOutputCount: 2, musicPromptCharacters: 3000 },
};

export function audioServiceSupports(provider: AudioProvider, operation: AudioOperation): boolean {
  return AUDIO_SERVICE_CAPABILITIES[provider].operations.includes(operation);
}

export interface AudioServiceChoice {
  id: string;
  name: string;
  provider: AudioProvider;
}
