import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { createSunoApiAudioAdapter } from "../audio-services/sunoapi.js";
import { createSession } from "../storage/sessions.js";
import { saveGlobalSettings } from "../storage/settings.js";
import { listAudioJobs, updateAudioJob } from "../storage/audio-jobs.js";
import { waveBytes } from "../storage/audio-storage-test-helpers.js";
import { generateAudio } from "./audio-generation.js";
import { audioJobViews, resumeAudioJob } from "./audio-processing.js";

async function harness(t: { after(fn: () => Promise<void>): void }) {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-suno-jobs-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Suno", projectKey: "project", scope: { kind: "selection", identity: "selection", label: "Audio" } });
  const apiKey = "fixture-third-party-key";
  const callbackUrl = "https://hooks.example.com/suno";
  await saveGlobalSettings(directory, { audioServices: { action: "upsert", expectedRevision: "0",
    connection: { id: "suno-connection", name: "Suno third party", provider: "sunoapi", enabled: true, apiKey, callbackUrl } } });
  const controller = new AbortController();
  const calls: Array<{ url: string; method: string }> = [];
  let inspectCount = 0;
  const mode = { failSecond: false, failFirst: false, inspectOffline: false, onlyOne: false, stopAfterReceipt: false };
  const generationAdapter = createSunoApiAudioAdapter(apiKey, { callbackUrl, fetchImpl: (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "POST") {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.callBackUrl, callbackUrl);
      assert.equal(body.customMode, false);
      assert.equal(body.prompt, "Original piano idea");
      if (mode.stopAfterReceipt) controller.abort(new Error("stopped"));
      return Response.json({ code: 200, msg: "success", data: { taskId: "task-one" } });
    }
    if (url.includes("/record-info?")) {
      if (mode.inspectOffline) return new Response("offline", { status: 503 });
      assert.ok(url.endsWith("taskId=task-one"));
      inspectCount++;
      if (inspectCount === 1) return Response.json({ code: 200, msg: "success", data: { taskId: "task-one", status: "PENDING", response: null } });
      return Response.json({ code: 200, msg: "success", data: { taskId: "task-one", status: "SUCCESS", response: {
        taskId: "task-one", sunoData: [
          ...(mode.onlyOne ? [] : [{ id: "track-b", audio_url: "https://file.aiquickdraw.com/second.wav" }]),
          { id: "track-a", audio_url: "https://file.aiquickdraw.com/first.wav" },
        ],
      } } });
    }
    assert.equal(new Headers(init?.headers).has("Authorization"), false);
    if (url.endsWith("first.wav") && mode.failFirst) return new Response("offline", { status: 503 });
    if (url.endsWith("second.wav") && mode.failSecond) return new Response("offline", { status: 503 });
    return new Response(waveBytes().slice().buffer, { headers: { "content-type": "audio/wav" } });
  }) as typeof fetch });
  const context = { storageDirectory: directory, sessionId: session.id, signal: controller.signal,
    generationAdapter, wait: async () => {} };
  return { directory, session, controller, context, calls, mode };
}

test("Suno task results retain partial audio and Resume downloads only the missing variant", async (t) => {
  const h = await harness(t);
  h.mode.failSecond = true;
  const first = await generateAudio(h.context, "suno-connection", { operation: "generate_music", prompt: "Original piano idea", instrumental: true });
  assert.equal(first.status, "partial");
  assert.equal(first.provider, "sunoapi"); assert.equal(first.remoteTaskId, "task-one");
  assert.deepEqual(first.outputAssets.map((asset) => asset.role), ["music"]);
  assert.equal((await audioJobViews(h.directory, h.session.id))[0]?.resumable, true);
  h.mode.failSecond = false;
  const completed = await resumeAudioJob(h.context, first.id);
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.outputAssets.map((asset) => asset.role), ["music", "music_alternative"]);
  assert.equal(h.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(h.calls.filter((call) => call.url.endsWith("first.wav")).length, 1);
  assert.doesNotMatch(JSON.stringify(await audioJobViews(h.directory, h.session.id)), /fixture-third-party|hooks\.example|file\.aiquickdraw|task-one/);
});

test("failure of the first variant never prevents saving a later available variant", async (t) => {
  const h = await harness(t);
  h.mode.failFirst = true;
  const partial = await generateAudio(h.context, "suno-connection", { operation: "generate_music", prompt: "Original piano idea", instrumental: true });
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.outputAssets.map((asset) => asset.role), ["music_alternative"]);
  assert.equal(h.calls.filter((call) => call.url.endsWith("second.wav")).length, 1);
  const resumed = await resumeAudioJob(h.context, partial.id);
  assert.equal(resumed.status, "partial");
  assert.equal(h.calls.filter((call) => call.url.endsWith("second.wav")).length, 1);
  assert.equal(h.calls.filter((call) => call.method === "POST").length, 1);
});

for (const onlyOne of [false, true]) {
  test(`all ${onlyOne ? "one" : "two"} saved async outputs recover locally when remote status is unavailable`, async (t) => {
    const h = await harness(t);
    h.mode.onlyOne = onlyOne;
    const first = await generateAudio(h.context, "suno-connection", { operation: "generate_music", prompt: "Original piano idea", instrumental: true });
    assert.equal(first.status, "completed");
    await updateAudioJob(h.directory, h.session.id, first.id, { status: "collecting", outputAssets: [] });
    h.mode.inspectOffline = true;
    const before = h.calls.length;
    const recovered = await resumeAudioJob(h.context, first.id);
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.outputAssets.length, onlyOne ? 1 : 2);
    assert.equal(h.calls.length, before, "no provider request is needed for an entirely saved result");
  });
}

test("Suno's accepted receipt survives Stop without claiming service-side cancellation", async (t) => {
  const h = await harness(t);
  h.mode.stopAfterReceipt = true;
  await assert.rejects(generateAudio(h.context, "suno-connection", { operation: "generate_music", prompt: "Original piano idea", instrumental: false }), /stopped/);
  const job = (await listAudioJobs(h.directory, h.session.id))[0]!;
  assert.equal(job.remoteTaskId, "task-one");
  assert.equal(job.status, "interrupted");
  assert.match(job.message!, /does not confirm service-side cancellation/);
  assert.equal(h.calls.length, 1);
  const completed = await resumeAudioJob({ ...h.context, signal: new AbortController().signal }, job.id);
  assert.equal(completed.status, "completed");
  assert.equal(h.calls.filter((call) => call.method === "POST").length, 1);
});
