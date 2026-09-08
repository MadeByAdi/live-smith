import assert from "node:assert/strict";
import test from "node:test";
import { audioProcessingTools, parseAudioToolRequest, validateAudioServiceRequest } from "./audio-tools.js";
import { AgentExternalToolReportingError, runAgentLoop } from "./loop.js";

test("audio tools project supported combinations and strictly parse bounded source locators", () => {
  assert.deepEqual(audioProcessingTools([]).map((tool) => tool.function.name), ["resume_audio_job", "list_audio_jobs"]);
  assert.equal(audioProcessingTools([{ id: "splitter", name: "Stems", provider: "lalal" }]).length, 3);
  const request = { serviceId: "splitter", source: { kind: "audio_asset", assetRef: "asset_known" }, stems: ["vocals", "drums"] };
  assert.deepEqual(parseAudioToolRequest("separate_stems", JSON.stringify(request)), { kind: "separate_stems", ...request });
  for (const invalid of [
    { ...request, stems: ["vocals", "vocals"] },
    { ...request, stems: ["synthesizer"] },
    { ...request, apiKey: "key" },
    { ...request, source: { kind: "audio_asset", assetRef: "../../secret" } },
    { ...request, source: { kind: "arrangement_audio", startBeat: 4, endBeat: 2 } },
    { ...request, source: { kind: "request_audio_attachment", requestId: "request", audioIndex: 2 } },
  ]) assert.throws(() => parseAudioToolRequest("separate_stems", JSON.stringify(invalid)));
});

test("audio tools expose distinct operations only for eligible named connections", () => {
  const tools = audioProcessingTools([
    { id: "stems", name: "Separation account", provider: "lalal" },
    { id: "music-one", name: "Music account A", provider: "elevenlabs" },
    { id: "music-two", name: "Music account B", provider: "elevenlabs" },
    { id: "unverified", name: "Suno", provider: "suno" },
  ]);
  const music = tools.find((tool) => tool.function.name === "generate_music")!;
  assert.ok(music);
  assert.match(JSON.stringify(music.function.parameters), /music-one/);
  assert.match(JSON.stringify(music.function.parameters), /music-two/);
  assert.doesNotMatch(JSON.stringify(music.function.parameters), /stems|unverified/);
  assert.ok(tools.find((tool) => tool.function.name === "generate_sound_effect"));
});

test("music and sound-effect requests validate operation-specific options and never accept connection secrets", () => {
  const music = { serviceId: "music-one", prompt: "Sparse ambient piano", durationSeconds: 12, instrumental: true };
  assert.deepEqual(parseAudioToolRequest("generate_music", JSON.stringify(music)), { kind: "generate_music", ...music });
  const effect = { serviceId: "music-one", prompt: "Gentle rain", durationSeconds: 2.5, loop: true };
  assert.deepEqual(parseAudioToolRequest("generate_sound_effect", JSON.stringify(effect)), { kind: "generate_sound_effect", ...effect });
  for (const invalid of [
    { ...music, serviceId: "../key" }, { ...music, apiKey: "secret" },
    { ...music, baseUrl: "https://example.com" }, { ...music, prompt: " " },
    { ...music, prompt: "x".repeat(4101) }, { ...music, durationSeconds: 601 },
    { ...music, instrumental: "yes" }, { ...music, loop: true },
  ]) assert.throws(() => parseAudioToolRequest("generate_music", JSON.stringify(invalid)));
  for (const invalid of [{ ...effect, durationSeconds: 0.1 }, { ...effect, durationSeconds: 31 },
    { ...effect, loop: "true" }, { ...effect, instrumental: true }]) {
    assert.throws(() => parseAudioToolRequest("generate_sound_effect", JSON.stringify(invalid)));
  }
});

test("third-party Suno music declares its prompt limit and does not silently discard a duration", () => {
  const services = [{ id: "suno-third-party", name: "Suno via SunoAPI.org", provider: "sunoapi" as const }];
  const tools = audioProcessingTools(services);
  const music = tools.find((tool) => tool.function.name === "generate_music")!;
  assert.match(music.function.description, /sunoapi/);
  assert.match(JSON.stringify(music.function.parameters), /3000/);
  assert.doesNotMatch(JSON.stringify(music.function.parameters), /durationSeconds/);
  assert.ok(!tools.some((tool) => tool.function.name === "generate_sound_effect"));
  const parsed = parseAudioToolRequest("generate_music", JSON.stringify({ serviceId: services[0]!.id, prompt: "Ambient piano", instrumental: true }));
  validateAudioServiceRequest(parsed, services);
  assert.throws(() => validateAudioServiceRequest({ ...parsed, kind: "generate_music", serviceId: services[0]!.id, prompt: "Ambient piano", instrumental: true, durationSeconds: 10 }, services));
  assert.throws(() => validateAudioServiceRequest({ kind: "generate_music", serviceId: services[0]!.id, prompt: "a".repeat(3001), instrumental: false }, services));
});

test("external audio result returns to the next model turn without a Live observation or mutation", async () => {
  let turns = 0;
  let executions = 0;
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    externalTools: { names: ["separate_stems"], execute: async () => { executions++; return { content: "asset_result", progressKey: "job" }; } },
    askModel: async ({ messages }) => {
      if (++turns === 1) return { content: null, toolCalls: [{ id: "call", name: "separate_stems", arguments: "{}" }] };
      assert.deepEqual(messages.at(-1), { role: "tool", toolCallId: "call", content: "asset_result" });
      return { content: "Separated.", toolCalls: [] };
    },
    observe: async () => { throw new Error("must not observe Live"); },
    confirmActions: async () => { throw new Error("must not confirm Live"); },
    executeActions: async () => { throw new Error("must not mutate Live"); },
  });
  assert.equal(result.message, "Separated."); assert.equal(executions, 1);
});

test("unknown external operation outcomes stop the send without a repair resubmission", async () => {
  let turns = 0;
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    externalTools: { names: ["separate_stems"], execute: async () => ({ content: "submission unknown", failed: true, stop: true }) },
    askModel: async () => { turns++; return { content: null, toolCalls: [{ id: "call", name: "separate_stems", arguments: "{}" }] }; },
    observe: async () => "", confirmActions: async () => false,
    executeActions: async () => ({ results: [], mutationCount: 0 }),
  });
  assert.equal(result.message, "submission unknown"); assert.equal(turns, 1);
});

test("a failed external result event cannot turn an unknown paid outcome into a retry", async () => {
  let submissions = 0;
  await assert.rejects(runAgentLoop({
    maxConsecutiveFailures: 2,
    externalTools: { names: ["separate_stems"], execute: async () => {
      submissions++; return { content: "unknown paid outcome", failed: true, stop: true };
    } },
    askModel: async () => ({ content: null, toolCalls: [{ id: "call", name: "separate_stems", arguments: "{}" }] }),
    observe: async () => "", confirmActions: async () => false,
    executeActions: async () => ({ results: [], mutationCount: 0 }),
    onEvent: async (event) => { if (event.kind === "tool_result") throw new Error("storage unavailable"); },
  }), (error: unknown) => error instanceof AgentExternalToolReportingError && error.outcome?.stop === true);
  assert.equal(submissions, 1);
});

test("pending steering cannot bypass an external terminal outcome", async () => {
  let pending = false;
  let consumed = false;
  let submissions = 0;
  const result = await runAgentLoop({
    maxConsecutiveFailures: 2,
    hasPendingSteering: () => pending,
    consumeSteering: async () => {
      if (!pending) return [];
      consumed = true; pending = false; return ["Put the result on track two"];
    },
    externalTools: { names: ["separate_stems"], execute: async () => {
      submissions++; pending = true; return { content: "unknown paid outcome", failed: true, stop: true };
    } },
    askModel: async () => ({ content: null, toolCalls: [{ id: "call", name: "separate_stems", arguments: "{}" }] }),
    observe: async () => "", confirmActions: async () => false,
    executeActions: async () => ({ results: [], mutationCount: 0 }),
  });
  assert.equal(result.message, "unknown paid outcome");
  assert.equal(submissions, 1); assert.equal(consumed, false); assert.equal(pending, true);
});
