import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";

import { SEPARATION_STEMS, type AudioServiceAdapter, type AudioGenerationAdapter } from "../audio-services/contracts.js";
import { createSession } from "../storage/sessions.js";
import { saveGlobalSettings } from "../storage/settings.js";
import { saveSessionAttachment } from "../storage/attachments.js";
import { loadSessionEvents } from "../storage/events.js";
import { listAudioJobs } from "../storage/audio-jobs.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import { runtimeProfileForSavedProfile } from "./model-request.js";
import { handleAgentRequest } from "./agent-request.js";
import { liveContextPresentationFixture } from "./live-context.test-harness.js";

test("a text-only chat model separates an attached file and reuses saved stems in a later send", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-audio-integration-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Stems", projectKey: "project", scope: { kind: "track", identity: "1", label: "Track" } });
  await saveGlobalSettings(directory, { audioServices: { action: "upsert", expectedRevision: "0",
    connection: { id: "splitter", name: "Stem account", provider: "lalal", enabled: true, apiKey: "fixture-private-audio-key" } } });
  await saveSessionAttachment(directory, session.id, { fileName: "reference.wav", bytes: waveBytes() }, { preSavePendingAttachmentRefs: [] });
  const runtime = runtimeProfileForSavedProfile({
    id: "text-profile", name: "Text model", defaultModel: "model",
    connection: { kind: "direct-api", apiFamily: "openai", apiMode: "responses", baseUrl: "https://example.test", apiKey: "model-test-key" },
    models: [{ model: "model", parameters: { maxOutputTokens: 1024, reasoning: { mode: "default" } }, advanced: {} }],
  });
  let uploads = 0;
  const adapter: AudioServiceAdapter = {
    provider: "lalal", stems: SEPARATION_STEMS,
    upload: async (bytes) => { assert.deepEqual(bytes, waveBytes()); uploads++; return "source"; },
    submit: async () => "task",
    inspect: async () => ({ status: "completed", outputs: [
      { key: "vocals", role: "vocals", url: "https://d.lalal.ai/a" },
      { key: "rest", role: "residual", url: "https://d.lalal.ai/b" },
    ] }),
    download: async () => waveBytes(),
  };
  const interaction = { summary: "Track", presentation: liveContextPresentationFixture("Track"), target: {}, scope: session.scope };
  const context = { application: { song: { tempo: 120 } }, environment: { storageDirectory: directory, tempDirectory: directory } } as never;
  const callbacks = {
    signal: new AbortController().signal,
    onDelta() {}, onProgress() {}, onSessionEvent() {},
    confirmActions: async () => { throw new Error("Separation must not modify Live"); },
    audioProcessing: { adapter, wait: async () => {} },
  };
  let turns = 0;
  let assetId = "";
  const first = await handleAgentRequest(context, directory, interaction, "Separate vocals", runtime, "project", session.id, callbacks, async (request) => {
    assert.ok(request.tools.some((tool) => tool.type === "function" && tool.function.name === "separate_stems"));
    assert.ok(request.attachmentParts?.every((part) => part.type !== "audio"));
    if (++turns === 1) {
      const match = request.requestAudioSampleSourceInstructions?.match(/Audio input 1: (\{[^\n]+\})/);
      assert.ok(match?.[1]);
      return { content: null, toolCalls: [{ id: "split", name: "separate_stems", arguments: JSON.stringify({ serviceId: "splitter", source: JSON.parse(match[1]), stems: ["vocals"] }) }] };
    }
    const result = JSON.parse(request.agentMessages.at(-1)!.content!);
    assert.equal(result.status, "completed");
    assetId = result.outputs[0].id;
    assert.match(request.requestAudioSampleSourceInstructions ?? "", new RegExp(assetId));
    return { content: "Stems ready.", toolCalls: [] };
  });
  assert.equal(first, "Stems ready."); assert.equal(uploads, 1);
  await handleAgentRequest(context, directory, interaction, "Show previous results", runtime, "project", session.id, callbacks, async (request) => {
    assert.match(request.requestAudioSampleSourceInstructions ?? "", new RegExp(assetId));
    assert.doesNotMatch(JSON.stringify(request), /fixture-private-audio-key|d\.lalal\.ai/);
    return { content: "Previous stems are available.", toolCalls: [] };
  });
  const history = JSON.stringify(await loadSessionEvents(directory, session.id));
  assert.doesNotMatch(history, /fixture-private-audio-key|d\.lalal\.ai|\/private\/tmp\//);
});

test("a text-only chat model generates music through a named connection and exposes it on the next send", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-music-integration-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Music", projectKey: "project", scope: { kind: "track", identity: "1", label: "Track" } });
  await saveGlobalSettings(directory, { audioServices: { action: "upsert", expectedRevision: "0",
    connection: { id: "music-account", name: "Music production", provider: "elevenlabs", enabled: true, apiKey: "fixture-music-secret" } } });
  const runtime = runtimeProfileForSavedProfile({
    id: "text-profile", name: "Text model", defaultModel: "model",
    connection: { kind: "direct-api", apiFamily: "openai", apiMode: "responses", baseUrl: "https://example.test", apiKey: "model-test-key" },
    models: [{ model: "model", parameters: { maxOutputTokens: 1024, reasoning: { mode: "default" } }, advanced: {} }],
  });
  let generations = 0;
  const generationAdapter: AudioGenerationAdapter = { provider: "elevenlabs", submit: async (request) => {
    assert.deepEqual(request, { operation: "generate_music", prompt: "Ambient piano", durationSeconds: 10, instrumental: true });
    generations++;
    return { kind: "audio", outputs: [{ role: "music", bytes: waveBytes() }] };
  } };
  const interaction = { summary: "Track", presentation: liveContextPresentationFixture("Track"), target: {}, scope: session.scope };
  const context = { application: { song: { tempo: 120 } }, environment: { storageDirectory: directory, tempDirectory: directory } } as never;
  const callbacks = { signal: new AbortController().signal, onDelta() {}, onProgress() {}, onSessionEvent() {},
    confirmActions: async () => { throw new Error("Generation must not modify Live"); }, audioProcessing: { generationAdapter } };
  let turns = 0;
  let assetId = "";
  const first = await handleAgentRequest(context, directory, interaction, "Generate ambient piano", runtime, "project", session.id, callbacks, async (request) => {
    assert.ok(request.tools.some((tool) => tool.type === "function" && tool.function.name === "generate_music"));
    assert.ok(!request.tools.some((tool) => tool.type === "function" && tool.function.name === "separate_stems"));
    if (++turns === 1) return { content: null, toolCalls: [{ id: "music-call", name: "generate_music", arguments: JSON.stringify({
      serviceId: "music-account", prompt: "Ambient piano", durationSeconds: 10, instrumental: true,
    }) }] };
    const result = JSON.parse(request.agentMessages.at(-1)!.content!);
    assert.equal(result.status, "completed"); assert.equal(result.serviceId, "music-account");
    assert.equal(result.operation, "generate_music"); assetId = result.outputs[0].id;
    assert.match(request.requestAudioSampleSourceInstructions ?? "", new RegExp(assetId));
    return { content: "Music ready.", toolCalls: [] };
  });
  assert.equal(first, "Music ready."); assert.equal(generations, 1);
  assert.equal((await listAudioJobs(directory, session.id))[0]?.outputAssets[0]?.id, assetId);
  await handleAgentRequest(context, directory, interaction, "Use that music", runtime, "project", session.id, callbacks, async (request) => {
    assert.match(request.requestAudioSampleSourceInstructions ?? "", new RegExp(assetId));
    assert.doesNotMatch(JSON.stringify(request), /fixture-music-secret|\/private\/tmp/);
    return { content: "The saved music is available.", toolCalls: [] };
  });
  assert.doesNotMatch(JSON.stringify(await loadSessionEvents(directory, session.id)), /fixture-music-secret|\/private\/tmp/);
});
