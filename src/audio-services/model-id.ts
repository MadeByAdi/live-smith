/** Saved music model identifiers are opaque printable ASCII, without spaces. */
export function isAudioServiceModelId(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,128}$/.test(value);
}
