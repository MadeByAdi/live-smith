import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { UI_LANGUAGES, isUiLanguage } from "../../i18n/languages.js";
import { parseCommandInput } from "../../app/chat-bridge-http.js";
import { freshEmptyAgentSettings } from "../../model/profile.js";
import { decodeAgentSettings } from "../../storage/settings-migrations.js";
import { createDialogHarness, stateFixture } from "../chat-dialog.test-harness.js";
import { serializeUiI18nData } from "./messages.js";

test("every registered language is accepted by settings, commands, and the composed picker", async () => {
  const harness = await createDialogHarness(stateFixture());
  try {
    const options = [...harness.document.querySelectorAll<HTMLOptionElement>("#uiLanguage option")];
    assert.deepEqual(options.map(option => option.value), ["system", ...UI_LANGUAGES.map(language => language.id)]);
    for (const language of UI_LANGUAGES) {
      assert.equal(isUiLanguage(language.id), true);
      assert.equal(decodeAgentSettings({ ...freshEmptyAgentSettings(), uiLanguage: language.id }).uiLanguage, language.id);
      assert.deepEqual(parseCommandInput({ kind: "save_global_settings", uiLanguage: language.id }),
        { kind: "save_global_settings", uiLanguage: language.id });
      assert.equal(options.find(option => option.value === language.id)?.textContent, language.nativeName);
    }
    assert.equal(isUiLanguage("unregistered"), false);
    assert.throws(() => parseCommandInput({ kind: "save_global_settings", uiLanguage: "unregistered" }));
  } finally { harness.close(); }
});

test("an added French catalog supplies locale matching, picker labels, interpolation and fallback without runtime branches", async () => {
  const data = JSON.parse(serializeUiI18nData());
  data.languages.push({ id: "fr", nativeName: "Français", aliases: ["fr"] });
  data.catalogs.fr = { "Agent": "Assistant", "System language": "Langue du système", "Beats {start}–{end}": "Temps {start} à {end}" };
  const script = readFileSync(new URL("../client/i18n.script.html", import.meta.url), "utf8")
    .replace("__UI_I18N__", () => JSON.stringify(data));
  const dom = new JSDOM(`<script>${script}</script><select id="uiLanguage"><option value="system" data-i18n="System language">System language</option></select><button data-i18n="Agent">Agent</button>`, {
    runScripts: "dangerously",
    beforeParse(window) { Object.defineProperty(window.navigator, "languages", { value: ["fr-CA", "en"], configurable: true }); },
  });
  try {
    await new Promise<void>(resolve => dom.window.addEventListener("DOMContentLoaded", () => resolve(), { once: true }));
    const i18n = (dom.window as unknown as { LiveSmithI18n: {
      configure(value: string): void; apply(): void; isLanguage(value: unknown): boolean;
      t(source: string, values?: Record<string, string | number>): string;
      format(value: unknown): string;
    } }).LiveSmithI18n;
    assert.equal(dom.window.document.documentElement.lang, "fr");
    assert.equal(i18n.isLanguage("fr"), true);
    assert.equal(dom.window.document.querySelector("option[value=fr]")?.textContent, "Français");
    assert.equal(dom.window.document.querySelector("button")?.textContent, "Assistant");
    assert.equal(i18n.t("Beats {start}–{end}", { start: 8, end: 16 }), "Temps 8 à 16");
    assert.equal(i18n.t("Missing French translation"), "Missing French translation");
    assert.equal(i18n.format("Agent"), "Agent");
    i18n.configure("en"); i18n.apply();
    assert.equal(dom.window.document.querySelector("button")?.textContent, "Agent");
    i18n.configure("fr"); i18n.apply();
    assert.equal(dom.window.document.documentElement.lang, "fr");
    assert.equal(dom.window.document.querySelector("button")?.textContent, "Assistant");
    assert.equal(dom.window.document.querySelectorAll("option[value=fr]").length, 1);
    Object.defineProperty(dom.window.navigator, "languages", { value: ["de-DE"] });
    i18n.configure("system");
    assert.equal(dom.window.document.documentElement.lang, "en");
  } finally { dom.window.close(); }
});
