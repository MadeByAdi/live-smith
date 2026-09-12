import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { freshEmptyAgentSettings, cloneAgentSettings, isAudioServiceCallbackUrl, normalizeAudioServiceConnection } from "../model/profile.js";
import { parseCommandInput, parseSendInput } from "../app/chat-bridge-http.js";
import { LEGACY_AUDIO_SERVICE_ID, MAX_AUDIO_SERVICES, type AudioServiceConnection,
  type AudioServicesSettingsPatch } from "../audio-services/contracts.js";
import { decodeAgentSettings } from "./settings-migrations.js";
import { audioServicesView, loadAgentSettings, saveGlobalSettings } from "./settings.js";

function connection(overrides: Partial<AudioServiceConnection> = {}): AudioServiceConnection {
  return { id: "audio-work", name: "Work separation", provider: "lalal", enabled: true,
    apiKey: "fixture-work", ...overrides };
}
function upsert(expectedRevision = "0", overrides: Partial<AudioServiceConnection> = {}): AudioServicesSettingsPatch {
  return { action: "upsert", expectedRevision, connection: connection(overrides) };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "live-smith-audio-settings-"));
  return { directory, file: join(directory, "live-smith-settings.json"),
    save: (audioServices: AudioServicesSettingsPatch) => saveGlobalSettings(directory, { audioServices }) };
}

test("plural settings round-trip, deep clone, and project only independent credential presence", () => {
  const original = freshEmptyAgentSettings();
  assert.equal(decodeAgentSettings(original).audioServices, undefined);
  assert.deepEqual(audioServicesView(undefined), { connections: [], revision: "0" });
  const settings = { ...original, audioServices: { connections: [connection(),
    connection({ id: "audio-music", name: "Music", provider: "elevenlabs", modelId: "music_v2" })], revision: "19" } };
  assert.deepEqual(decodeAgentSettings(settings), settings);
  const clone = cloneAgentSettings(settings);
  clone.audioServices!.connections[0]!.apiKey = "replacement";
  assert.equal(settings.audioServices.connections[0]!.apiKey, "fixture-work");
  const view = audioServicesView(settings.audioServices);
  assert.equal(view.connections.length, 2);
  assert.equal(view.connections[1]!.modelId, "music_v2");
  assert.doesNotMatch(JSON.stringify(view), /fixture-work|"apiKey":/);
});

test("SunoAPI callback persists and projects without keys; enabling requires callback and its own key", async () => {
  const { directory, file, save } = await fixture();
  await save(upsert());
  await save(upsert("1", { id: "music", name: "Music", provider: "elevenlabs", modelId: "music_v2" }));
  const suno = { id: "suno-api", name: "Third-party music", provider: "sunoapi" as const, enabled: false };
  const disabled = await save({ action: "upsert", expectedRevision: "2", connection: suno });
  const before = await readFile(file, "utf8");
  await assert.rejects(save({ action: "upsert", expectedRevision: "3", connection: { ...suno, enabled: true, apiKey: "fixture-suno" } }), /callback/i);
  const callbackUrl = "https://hooks.example.com/%E9%9F%B3%E4%B9%90";
  await assert.rejects(save({ action: "upsert", expectedRevision: "3", connection: { ...suno, enabled: true, callbackUrl } }), /API key/);
  assert.equal(await readFile(file, "utf8"), before);
  const saved = await save({ action: "upsert", expectedRevision: "3", connection: {
    ...suno, enabled: true, callbackUrl, apiKey: "fixture-suno", modelId: "V4_5ALL",
  } });
  assert.deepEqual(saved.audioServices!.connections.slice(0, 2), disabled.audioServices!.connections.slice(0, 2));
  assert.deepEqual(await loadAgentSettings(directory), saved);
  const clone = cloneAgentSettings(saved);
  clone.audioServices!.connections[2]!.callbackUrl = "https://other.example.com/hook";
  assert.equal(saved.audioServices!.connections[2]!.callbackUrl, callbackUrl);
  assert.equal(audioServicesView(saved.audioServices).connections[2]!.callbackUrl, callbackUrl);
  assert.doesNotMatch(JSON.stringify(audioServicesView(saved.audioServices)), /fixture-suno|"apiKey":/);
  await assert.rejects(save({ action: "upsert", expectedRevision: "4", connection: {
    ...suno, enabled: true, callbackUrl: "https://hooks.example.com/%66ixture-suno",
  } }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /callback URL must not contain API credentials/);
    assert.doesNotMatch(error.message, /fixture-suno/);
    return true;
  });
  const switched = await save({ action: "upsert", expectedRevision: "4", connection: { ...suno, provider: "lalal" } });
  assert.deepEqual(switched.audioServices!.connections[2], { ...suno, provider: "lalal", apiKey: "" });
});

test("music model IDs use the consumed 128-character configuration boundary", () => {
  const command = { kind: "save_global_settings", audioServices: upsert("0", {
    provider: "elevenlabs", modelId: "m".repeat(128),
  }) };
  assert.deepEqual(parseCommandInput(command), command);
  assert.throws(() => parseCommandInput({ ...command, audioServices: upsert("0", {
    provider: "elevenlabs", modelId: "m".repeat(129),
  }) }));
});

test("official Suno Platform is a separate API-key connection without website Cookie or model fields", async () => {
  const { save } = await fixture();
  const platform = { id: "suno-platform", name: "Official Suno", provider: "suno-platform" as const, enabled: false };
  const disabled = await save({ action: "upsert", expectedRevision: "0", connection: platform });
  assert.deepEqual(disabled.audioServices?.connections[0], { ...platform, apiKey: "" });
  await assert.rejects(save({ action: "upsert", expectedRevision: "1", connection: { ...platform, enabled: true } }), /API key/);
  const enabled = await save({ action: "upsert", expectedRevision: "1", connection: {
    ...platform, enabled: true, apiKey: "fixture-platform-key",
  } });
  assert.equal(enabled.audioServices?.connections[0]?.provider, "suno-platform");
  assert.throws(() => normalizeAudioServiceConnection({ ...platform, apiKey: "", modelId: "v6" }), /not configurable/u);
  assert.throws(() => normalizeAudioServiceConnection({ ...platform, apiKey: "", callbackUrl: "https://example.test/hook" }), /callback/u);
});

test("callback validation rejects malformed or credential-bearing URLs without reflecting input, and fields require their provider consumer", () => {
  for (const callbackUrl of ["", "ftp://hooks.example.com/cb",
    "https://fixture-secret@hooks.example.com/cb", "https://%66ixture-secret@hooks.example.com/cb",
    "https://@hooks.example.com/cb", "https://hooks.example.com/cb#",
    "https://hooks.example.com/cb#fixture-secret",
    "https://hooks.example.com\\@localhost/cb", "https://hooks.example.com/c b", " https://hooks.example.com/cb",
    "https://hooks.example.com/\ncb", "https://hooks.example.com/%", "https://hooks.example.com/%GG",
    "https://hooks.example.com/%C0%AF", "https://hooks.example.com/" + "a".repeat(2048), null]) {
    assert.throws(() => decodeAgentSettings({ ...freshEmptyAgentSettings(), audioServices: { revision: "0", connections: [
      { ...connection({ provider: "sunoapi", enabled: false }), callbackUrl },
    ] } }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /callback/i);
      assert.doesNotMatch(error.message, /fixture-secret/);
      return true;
    });
  }
  for (const callbackUrl of ["http://localhost:8787/cb?token=fixture", "https://127.0.0.1:9443/cb?stage=done",
    "https://hooks.example.com./cb?"]) assert.equal(isAudioServiceCallbackUrl(callbackUrl), true, callbackUrl);
  for (const fields of [{ provider: "lalal", callbackUrl: "https://hooks.example.com/cb" },
    { provider: "elevenlabs", callbackUrl: "https://hooks.example.com/cb" },
    { provider: "suno-platform", callbackUrl: "https://hooks.example.com/cb" },
    { provider: "suno", callbackUrl: "https://hooks.example.com/cb" }, { provider: "lalal", modelId: "unused" }]) {
    assert.throws(() => parseCommandInput({ kind: "save_global_settings", audioServices:
      { action: "upsert", expectedRevision: "0", connection: { ...connection(), ...fields, enabled: false } } }));
  }
});

test("legacy single service migrates on read preserving key and revision, then writes only plural state", async () => {
  const { directory, file, save } = await fixture();
  const source = JSON.stringify({ ...freshEmptyAgentSettings(), audioService:
    { provider: "lalal", enabled: true, apiKey: "fixture-legacy", revision: "9007199254740999" } });
  await writeFile(file, source);
  const loaded = await loadAgentSettings(directory);
  assert.deepEqual(loaded.audioServices, { revision: "9007199254740999", connections: [{
    id: LEGACY_AUDIO_SERVICE_ID, name: "LALAL.AI", provider: "lalal", enabled: true, apiKey: "fixture-legacy",
  }] });
  assert.equal(await readFile(file, "utf8"), source);
  const saved = await save({ action: "upsert", expectedRevision: loaded.audioServices!.revision,
    connection: { id: LEGACY_AUDIO_SERVICE_ID, name: "Migrated", provider: "lalal", enabled: true } });
  assert.equal(saved.audioServices?.revision, "9007199254741000");
  assert.equal(saved.audioServices?.connections[0]!.apiKey, "fixture-legacy");
  assert.equal(Object.hasOwn(JSON.parse(await readFile(file, "utf8")), "audioService"), false);
  assert.throws(() => decodeAgentSettings({ ...JSON.parse(source), audioServices: { connections: [], revision: "0" } }));
});

test("corrupt collections and connection fields fail without reflecting credentials", () => {
  const valid = { connections: [connection()], revision: "0" };
  for (const value of [null, {}, { ...valid, revision: "01" }, { ...valid, endpoint: "fixture-secret" },
    { ...valid, connections: [connection(), connection()] },
    { ...valid, connections: [connection(), connection({ id: "other", name: "work SEPARATION" })] },
    { ...valid, connections: Array.from({ length: MAX_AUDIO_SERVICES + 1 }, (_, n) => connection({ id: "c" + n, name: "C" + n })) },
    ...[{ id: "../audio" }, { name: " " }, { name: "bad\nname" }, { provider: "other" }, { enabled: true, apiKey: "" },
      { apiKey: "fixture-secret\nheader" }, { modelId: "bad model" }, { modelId: "" },
      { provider: "elevenlabs", modelId: "x".repeat(129) },
      { endpoint: "fixture-secret" }, { apiKey: "x".repeat(4097) }]
      .map((fields) => ({ ...valid, connections: [{ ...connection(), ...fields }] }))]) {
    assert.throws(() => decodeAgentSettings({ ...freshEmptyAgentSettings(), audioServices: value }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /fixture-secret/);
      return true;
    });
  }
});

test("same-provider accounts and multiple providers keep independent credentials through update, clear, and remove", async () => {
  const { directory, file, save } = await fixture();
  await save(upsert());
  await save(upsert("1", { id: "audio-personal", name: "Personal", apiKey: "fixture-personal" }));
  await save(upsert("2", { id: "audio-music", name: "Music", provider: "elevenlabs", apiKey: "fixture-music" }));
  const edited = await save({ action: "upsert", expectedRevision: "3",
    connection: { id: "audio-work", name: "Work renamed", provider: "lalal", enabled: false } });
  assert.deepEqual(edited.audioServices?.connections.map((service) => service.apiKey),
    ["fixture-work", "fixture-personal", "fixture-music"]);
  await saveGlobalSettings(directory, { uiLanguage: "zh-CN" });
  assert.deepEqual((await loadAgentSettings(directory)).audioServices, edited.audioServices);
  const cleared = await save(upsert("4", { enabled: false, apiKey: "" }));
  assert.deepEqual(cleared.audioServices?.connections.map((service) => [service.enabled, service.apiKey]),
    [[false, ""], [true, "fixture-personal"], [true, "fixture-music"]]);
  const removed = await save({ action: "remove", serviceId: "audio-personal", expectedRevision: "5" });
  assert.deepEqual(removed.audioServices?.connections.map((service) => service.id), ["audio-work", "audio-music"]);
  assert.doesNotMatch(await readFile(file, "utf8"), /fixture-work|fixture-personal/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("provider switches never inherit a key; Cookie-based services do not require API keys", async () => {
  const { save } = await fixture();
  await save(upsert());
  const replacement = { id: "audio-work", name: "Generation", provider: "elevenlabs" as const, enabled: true };
  await assert.rejects(save({ action: "upsert", expectedRevision: "1", connection: replacement }), /API key/);
  const disabled = await save({ action: "upsert", expectedRevision: "1", connection: { ...replacement, enabled: false } });
  assert.equal(disabled.audioServices?.connections[0]!.apiKey, "");
  await save(upsert("2", { provider: "elevenlabs", apiKey: "fixture-new" }));
  const unavailable = await save(upsert("3", { provider: "suno", enabled: false, apiKey: "" }));
  assert.equal(unavailable.audioServices?.connections[0]!.provider, "suno");
  const enabled = await save(upsert("4", { provider: "suno", apiKey: "" }));
  assert.equal(enabled.audioServices?.connections[0]!.enabled, true);
  assert.equal(enabled.audioServices?.connections[0]!.apiKey, "");
});

test("stale, invalid and missing-target writes are atomic; concurrency admits only one collection revision", async () => {
  const { directory, file, save } = await fixture();
  await save(upsert());
  const before = await readFile(file, "utf8");
  await assert.rejects(save(upsert("0", { apiKey: "fixture-stale" })), /changed in another window/);
  await assert.rejects(save({ action: "remove", serviceId: "missing", expectedRevision: "1" }), /no longer exists/);
  await assert.rejects(save(upsert("1", { id: "duplicate-name" })), /unique/);
  await assert.rejects(save(upsert("1", { apiKey: "" })), /API key/);
  assert.equal(await readFile(file, "utf8"), before);
  const results = await Promise.allSettled([
    save(upsert("1", { apiKey: "fixture-one" })), save(upsert("1", { apiKey: "fixture-two" })),
    saveGlobalSettings(directory, { showContextUsage: false }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  const stored = await loadAgentSettings(directory);
  assert.equal(stored.audioServices?.revision, "2");
  assert.equal(stored.showContextUsage, false);
  await assert.rejects(saveGlobalSettings(undefined, { audioServices: upsert() }), /persistent private storage/);
});

test("bridge accepts only strict plural action patches, with omitted keys remaining omitted", () => {
  const noKey = { id: "new", name: "New", provider: "lalal", enabled: false };
  for (const patch of [upsert(), { action: "upsert", expectedRevision: "0", connection: noKey },
    { action: "remove", expectedRevision: "3", serviceId: "old" }]) {
    const command = { kind: "save_global_settings", audioServices: patch };
    assert.deepEqual(parseCommandInput(command), command);
  }
  const resume = { kind: "resume_audio_job", sessionId: "session-1", jobId: "job-1" };
  assert.deepEqual(parseCommandInput(resume), resume);
  for (const patch of [null, {}, { ...upsert(), expectedRevision: "01" },
    { ...upsert(), connection: { ...noKey, apiKey: null } }, { ...upsert(), connection: { ...noKey, enabled: "true" } },
    { ...upsert(), connection: { ...noKey, apiKeyConfigured: true } }, { ...upsert(), serviceId: "foreign" },
    { action: "remove", expectedRevision: "0", serviceId: "../bad" },
    { action: "remove", expectedRevision: "0", serviceId: "ok", connection: noKey }]) {
    assert.throws(() => parseCommandInput({ kind: "save_global_settings", audioServices: patch }));
  }
  for (const command of [{ ...resume, jobId: "../job" }, { ...resume, apiKey: "fixture-secret" },
    { kind: "save_global_settings", audioService: { enabled: false, expectedRevision: "0" } },
    { kind: "save_global_settings", audioServices: upsert(), uiLanguage: "en" }]) {
    assert.throws(() => parseCommandInput(command));
  }
  assert.throws(() => parseSendInput({ prompt: "split", sessionId: "s1", audioServices: {} }));
});
