import assert from "node:assert/strict";
import test from "node:test";
import { commandCalls, createDialogHarness } from "./chat-dialog.test-harness.js";
import { audioState, broadcast, job, musicService, selectAudioService, toggle } from "./chat-dialog.audio-test-helpers.js";

const website = { id: "suno-personal", name: "Personal Suno", provider: "suno" as const, enabled: true, apiKeyConfigured: false };
const account = { serviceId: website.id, status: "signed_in" as const, accountId: "user_personal", accountName: "Musician" };
const ids = ["11111111-1111-4111-8111-111111111111", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"];
const stateForRetrieval = () => ({ ...audioState([website, musicService]), sunoAccounts: [account] });
type Harness = Awaited<ReturnType<typeof createDialogHarness>>;
const input = (h: Harness) => h.document.querySelector<HTMLTextAreaElement>("#sunoRetrieveSongs")!;
const button = (h: Harness) => h.document.querySelector<HTMLButtonElement>("#retrieveSunoSongsButton")!;

for (const language of ["en", "zh-CN"] as const) {
  test(`${language} retrieval guidance leads to online preview before any download confirmation`, async () => {
    const state = stateForRetrieval();
    state.settings.uiLanguage = language;
    const h = await createDialogHarness(state);
    try {
      const chinese = language === "zh-CN";
      h.click("#sunoRetrieveDetails > summary");
      assert.equal(h.document.querySelector("#sunoRetrieveDetails > summary")!.textContent,
        chinese ? "预览已有的 Suno 歌曲" : "Preview existing Suno songs");
      assert.equal(button(h).textContent, chinese ? "取回并预览" : "Retrieve for preview");
      assert.match(h.document.querySelector("#sunoRetrieveHelp")!.textContent!, chinese
        ? /预览无需下载授权，也不消耗下载额度.*选择下载并确认/s
        : /Preview does not require download authorization or use your download allowance.*choose Download and confirm/s);
      assert.match(h.document.querySelector("#audioServiceOperations")!.textContent!, chinese ? /取回并预览/ : /Retrieve & preview/);
      assert.match(h.document.querySelector("#sunoFeatureHelp")!.textContent!, chinese ? /取回已有歌曲以在线预览/ : /retrieve existing songs for online preview/);
      h.input("#sunoRetrieveSongs", ids[0]!);
      h.holdNextCommand(); button(h).click();
      const ready = job(state.activeSessionId, { serviceId: website.id, provider: "suno", operation: "retrieve_music",
        stems: [], status: "ready", outputs: [], remoteOutputs: [{ key: ids[0]!, role: "music" }], resumable: false });
      h.setServerState({ ...state, audioJobs: [ready] });
      h.releaseHeldCommand(); await h.settle();
      assert.equal(h.document.querySelector("#audioJobs h4")!.textContent, chinese ? "已生成 · 在线" : "Generated · online");
      assert.equal(h.document.querySelector("#audioJobs audio"), null);
      assert.equal(h.document.querySelector("#audioJobs iframe"), null);
      assert.equal(h.document.querySelector<HTMLElement>("#appConfirmation")!.hidden, true);
      h.click("[data-preview-audio]");
      assert.equal(h.document.querySelector<HTMLIFrameElement>("#audioJobs iframe")!.src, "https://suno.com/embed/" + ids[0]);
      assert.deepEqual(commandCalls(h).map((call) => call.body), [{ kind: "retrieve_music", sessionId: state.activeSessionId,
        serviceId: website.id, expectedAccountId: account.accountId, clipIds: [ids[0]] }]);
      h.click("[data-download-audio-output]");
      assert.match(h.document.querySelector("#appConfirmationMessage")!.textContent!, chinese ? /最多 1 次现有 Suno 下载额度/ : /up to one existing Suno download allowance/);
      await h.cancelAppConfirmation(); await h.settle();
      assert.equal(commandCalls(h).length, 1, "preview and cancelled file saving send no download command");
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
}

for (const status of ["signed_in", "saved"] as const) {
  test(`explicit retrieval with a ${status} account sends IDs and retains input after a failed command`, async () => {
    const state = { ...stateForRetrieval(), sunoAccounts: [{ ...account, status }] };
    const h = await createDialogHarness(state);
    try {
      h.click("#sunoRetrieveDetails > summary");
      assert.equal(h.document.querySelector<HTMLDetailsElement>("#sunoRetrieveDetails")!.open, true);
      const value = `https://suno.com/song/${ids[0]}\n${ids[1]!.toUpperCase()}`;
      h.input("#sunoRetrieveSongs", value);
      h.failNextCommand("Suno song lookup is temporarily unavailable.");
      h.holdNextCommand();
      button(h).click(); button(h).click();
      assert.equal(button(h).disabled, true);
      assert.equal(input(h).disabled, true);
      assert.deepEqual(commandCalls(h).map((call) => call.body), [{
        kind: "retrieve_music", sessionId: state.activeSessionId, serviceId: website.id,
        expectedAccountId: account.accountId, clipIds: ids,
      }]);
      h.releaseHeldCommand(); await h.settle();
      assert.equal(input(h).value, value);
      assert.equal(button(h).disabled, false);
      assert.deepEqual(h.errors, []);
    } finally { h.close(); }
  });
}

test("invalid song inputs never reach the bridge and focus the correction field", async () => {
  const h = await createDialogHarness(stateForRetrieval());
  try {
    for (const value of [
      "https://suno.com.evil.test/song/" + ids[0], "http://suno.com/song/" + ids[0],
      "https://user@suno.com/song/" + ids[0], "https://suno.com/song/" + ids[0] + "?token=secret",
      "https://suno.com/song/" + ids[0] + "#fragment", "https://suno.com/s/short-link",
      ids[0] + " " + ids[0], ids[1] + " " + ids[1]!.toUpperCase(), ids.join("\n") + "\n" + ids[0],
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "not-a-song", "x".repeat(513),
    ]) {
      h.input("#sunoRetrieveSongs", value); button(h).click(); await h.settle();
      assert.equal(commandCalls(h).length, 0, value);
      assert.equal(h.document.activeElement?.id, "sunoRetrieveSongs");
      assert.equal(input(h).value, value);
    }
    h.input("#sunoRetrieveSongs", " ");
    assert.equal(button(h).disabled, true);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("retrieval requires an enabled saved connection with usable account evidence", async () => {
  for (const status of ["signed_out", "expired", "unavailable"] as const) {
    const h = await createDialogHarness({ ...audioState([website]), sunoAccounts: [{ serviceId: website.id, status }] });
    try {
      assert.equal(input(h).disabled, true);
      assert.equal(button(h).disabled, true);
    } finally { h.close(); }
  }
  const h = await createDialogHarness(stateForRetrieval());
  try {
    h.input("#sunoRetrieveSongs", ids[0]!); toggle(h, false);
    assert.equal(button(h).disabled, true, "unsaved settings cannot enter retrieval");
    assert.equal(commandCalls(h).length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("changing the selected connection clears song input instead of transferring it", async () => {
  const second = { ...website, id: "suno-work", name: "Work Suno" };
  const h = await createDialogHarness({ ...audioState([website, second]), sunoAccounts: [account, { ...account, serviceId: second.id, accountId: "user_work" }] });
  try {
    h.input("#sunoRetrieveSongs", ids[0]!); selectAudioService(h, second.id);
    assert.equal(input(h).value, "");
    h.input("#sunoRetrieveSongs", ids[1]!); button(h).click(); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)?.body, { kind: "retrieve_music", sessionId: h.readBootstrappedClientStateReference().activeSessionId,
      serviceId: second.id, expectedAccountId: "user_work", clipIds: [ids[1]] });
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("a disabled connection readback cannot keep the retrieval action enabled", async () => {
  const state = stateForRetrieval();
  const h = await createDialogHarness(state);
  try {
    h.input("#sunoRetrieveSongs", ids[0]!);
    const services = { revision: "2", connections: [{ ...website, enabled: false }, musicService] };
    h.setServerState({ ...state, audioServices: services });
    h.emitServerEvent(broadcast(state, services)); await h.settle();
    assert.equal(button(h).disabled, true); assert.equal(input(h).disabled, true);
    assert.equal(commandCalls(h).length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("account and Session changes clear stale song input", async () => {
  const state = stateForRetrieval();
  const h = await createDialogHarness(state);
  try {
    h.input("#sunoRetrieveSongs", ids[0]!);
    h.setServerState({ ...state, sunoAccounts: [{ ...account, accountId: "user_replacement" }] });
    h.click("#refreshSunoLoginButton"); await h.settle();
    assert.equal(input(h).value, "");
    h.input("#sunoRetrieveSongs", ids[1]!);
    h.click('.session-entry[data-session-id="session-2"] .session-row'); await h.settle();
    assert.equal(input(h).value, "");
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("previously saved retrieved songs retain local Session playback and recovery", async () => {
  const state = stateForRetrieval();
  const result = job(state.activeSessionId, { serviceId: website.id, provider: "suno", operation: "retrieve_music", stems: [] });
  result.outputs = [{ ...result.outputs[0]!, role: "music", label: "Music", origin: { kind: "generated" } }];
  const h = await createDialogHarness({ ...state, audioJobs: [result] });
  try {
    assert.match(h.document.querySelector("#audioJobs")!.textContent!, /Retrieve for preview/);
    assert.match(h.document.querySelector<HTMLAudioElement>("#audioJobs audio")!.src, /\/audio-assets\//);
    h.click("[data-resume-audio-job]"); await h.settle();
    assert.deepEqual(commandCalls(h).at(-1)?.body, { kind: "resume_audio_job", sessionId: state.activeSessionId, jobId: result.id });
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("Stop during retrieval keeps authoritative partial audio and the selected song input", async () => {
  const state = stateForRetrieval();
  const partial = job(state.activeSessionId, { provider: "suno", serviceId: website.id, operation: "retrieve_music", stems: [] });
  partial.outputs = [{ ...partial.outputs[0]!, role: "music", origin: { kind: "generated" } }];
  const h = await createDialogHarness(state);
  try {
    h.input("#sunoRetrieveSongs", ids.join("\n"));
    h.failNextCommand("Command stopped by user.", undefined, { commandOutcome: "stopped", status: 409,
      state: { ...state, audioJobs: [partial], bridgeStateRevision: "100", bridgeStateCoveredThroughRevision: "100" } });
    h.holdNextCommand(); button(h).click(); await h.settle();
    assert.match(h.document.querySelector("#sendButton")!.textContent!, /Stop/);
    h.click("#sendButton"); h.releaseHeldCommand(); await h.settle();
    assert.equal(h.document.querySelectorAll("#audioJobs audio").length, 1);
    assert.equal(input(h).value, ids.join("\n"));
    assert.equal(button(h).disabled, false);
    assert.equal(h.document.querySelector<HTMLTextAreaElement>("#prompt")!.disabled, false);
    assert.equal(h.document.querySelector<HTMLButtonElement>("[data-resume-audio-job]")!.disabled, false);
    assert.equal(commandCalls(h).length, 1);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});

test("uncertain retrieval preserves its warning instead of announcing generated results", async () => {
  const state = stateForRetrieval();
  const h = await createDialogHarness(state);
  try {
    h.input("#sunoRetrieveSongs", ids[0]!);
    h.failNextCommand("Retrieval receipt is uncertain.", undefined, { commandOutcome: "unknown",
      state: { ...state, bridgeStateRevision: "100", bridgeStateCoveredThroughRevision: "100" } });
    button(h).click(); await h.settle();
    assert.match(h.document.querySelector("#status")!.textContent!, /Retrieval receipt is uncertain/);
    assert.equal(h.document.querySelectorAll("[data-audio-job-id]").length, 0);
    assert.equal(commandCalls(h).length, 1);
    assert.deepEqual(h.errors, []);
  } finally { h.close(); }
});
