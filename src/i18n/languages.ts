/** Shared by settings validation and the browser's locale resolver and picker. */
export const UI_LANGUAGES = [
  { id: "en", nativeName: "English", aliases: ["en"] },
  { id: "zh-CN", nativeName: "简体中文", aliases: ["zh"] },
] as const;

export type UiLocale = (typeof UI_LANGUAGES)[number]["id"];
export type UiLanguage = "system" | UiLocale;
export const DEFAULT_UI_LOCALE: UiLocale = "en";

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === "system" || UI_LANGUAGES.some(language => language.id === value);
}
