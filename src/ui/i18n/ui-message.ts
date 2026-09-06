/** Strings are raw data. Only explicit descriptors contain app-authored copy. */
export type UiMessage = string | UiMessageDescriptor;

export type UiMessageValues = Record<string, UiMessage | number | boolean>;

export interface UiMessageDescriptor {
  source: string;
  values: UiMessageValues;
}

/** Capture named values without formatting or interpreting their contents. */
export function uiMessage(
  source: string,
  values: UiMessageValues = {},
): UiMessageDescriptor {
  return { source, values: { ...values } };
}

/** English fallback for non-localized consumers; never translates raw strings. */
export function formatUiMessage(value: UiMessage | number | boolean): string {
  if (typeof value !== "object") return String(value);
  return value.source.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (field, key: string) => {
    if (!Object.hasOwn(value.values, key)) return field;
    return formatUiMessage(value.values[key]!);
  });
}
