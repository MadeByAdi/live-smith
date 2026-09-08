/** JSON Schema string limits count Unicode code points, not UTF-16 code units. */
export function exceedsAudioPromptLimit(prompt: string, limit: number): boolean {
  let characters = 0;
  for (const _character of prompt) {
    if (++characters > limit) return true;
  }
  return false;
}
