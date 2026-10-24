import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { ClipSlot, Device, MidiClip, MidiTrack } from "@ableton-extensions/sdk";

import {
  arrangementSelectionInteractionContext,
  clipSlotSelectionInteractionContext,
  interactionContextForScope,
  type LiveInteractionContext,
} from "../../../src/live/context.js";
import type { SavedProfile } from "../../../src/model/profile.js";
import { saveSavedProfile } from "../../../src/storage/settings.js";
import { createSession, listSessions } from "../../../src/storage/sessions.js";
import { loadSessionEvents } from "../../../src/storage/events.js";
import type { ChatBridgeState, ChatDialogState } from "../../../src/ui/chat-state.js";
import { runAgentFlow } from "../../../src/app/agent-flow.js";

test("state summary and presentation consume the same resolved selection interaction", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-context-projection-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let refreshCount = 0;
  const interaction: LiveInteractionContext = {
    summary: "Opening selection",
    presentation: {
      origin: "arrangement-selection", objectKind: "other", title: "Opening selection", details: [],
    },
    target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
    selectionContext: {
      refresh: () => {
        const observation = `Observation ${++refreshCount}`;
        return {
          ...interaction,
          summary: observation,
          presentation: { ...interaction.presentation, title: observation },
        };
      },
    },
  };
  const context = {
    application: { song: { handle: { id: 1n }, tracks: [], scenes: [] } },
    environment: { storageDirectory: directory },
    ui: { showModalDialog: async (url: string) => {
      const projected = await state(endpoint(url));
      assert.equal(projected.liveContext.availability, "available");
      assert.equal(projected.liveContext.sessionId, projected.activeSessionId);
      assert.equal(projected.liveContext.value.title, projected.contextSummary);
      assert.notEqual(projected.contextSummary, interaction.summary);
    } },
  };
  await runAgentFlow(context as never, interaction, { renderHtml: () => "<html></html>" });
});

test("opening an Arrangement selection keeps its bounded selection context", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-arrangement-context-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, profile());
  let modelLiveContext = "";
  const track = fakeMidiTrack(101n, "Bass");
  const context = {
    application: {
      song: { handle: { id: 1n }, tracks: [track], scenes: [] },
    },
    environment: { storageDirectory: directory },
    getObjectFromHandle: () => track,
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const state = await (
          await fetch(`${chatUrl.origin}/state?token=${token}`)
        ).json() as ChatDialogState;

        assert.match(state.contextSummary, /Arrangement selection: beats 8 to 16/);
        assert.match(state.contextSummary, /Lane 1: MIDI track "Bass"/);
        assert.deepEqual(state.liveContext, {
          sessionId: state.activeSessionId,
          availability: "available",
          value: {
            origin: "arrangement-selection", objectKind: "other", title: "Arrangement selection",
            details: ['MIDI track "Bass"'],
            range: { coordinate: "arrangement-beats", start: 8, end: 16 },
          },
        });
        const send = await fetch(`${chatUrl.origin}/send?token=${token}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Send-Id": "send-selection-context",
          },
          body: JSON.stringify({
            prompt: "Work with this selection",
            sessionId: state.activeSessionId,
          }),
        });
        assert.equal(send.status, 200);
        assert.match(modelLiveContext, /Arrangement selection: beats 8 to 16/);
        assert.equal(modelLiveContext, state.contextSummary);

        const newSelectionResponse = await fetch(
          `${chatUrl.origin}/command?token=${token}`,
          {
            method: "POST",
            headers: jsonHeaders("context-command-1"),
            body: JSON.stringify({ kind: "new_session" }),
          },
        );
        const newSelectionState = await newSelectionResponse.json() as ChatDialogState;
        assert.notEqual(newSelectionState.activeSessionId, state.activeSessionId);
        assert.match(
          newSelectionState.contextSummary,
          /Arrangement selection: beats 8 to 16/,
        );
        assert.deepEqual(newSelectionState.liveContext, {
          ...state.liveContext, sessionId: newSelectionState.activeSessionId,
        });

        const ordinarySession = await createSession(directory, {
          title: "Ordinary Bass Session",
          projectKey: state.sessions[0]!.projectKey,
          scope: { kind: "track", identity: "101", label: "Bass" },
        });
        const ordinaryResponse = await fetch(
          `${chatUrl.origin}/command?token=${token}`,
          {
            method: "POST",
            headers: jsonHeaders("context-command-2"),
            body: JSON.stringify({
              kind: "select_session",
              sessionId: ordinarySession.id,
            }),
          },
        );
        const ordinaryState = await ordinaryResponse.json() as ChatDialogState;
        assert.match(ordinaryState.contextSummary, /Arrangement selection: beats 8 to 16/);
        assert.deepEqual(ordinaryState.liveContext, {
          sessionId: ordinarySession.id,
          availability: "available",
          value: state.liveContext.value,
        });

        track.name = "Bass renamed";
        const refreshedOrdinary = await (
          await fetch(`${chatUrl.origin}/state?token=${token}`)
        ).json() as ChatDialogState;
        assert.match(refreshedOrdinary.contextSummary, /Arrangement selection: beats 8 to 16/);
        assert.equal(refreshedOrdinary.liveContext.availability, "available");
        assert.deepEqual(refreshedOrdinary.liveContext.value.details, ['MIDI track "Bass renamed"']);

        const selectionResponse = await fetch(
          `${chatUrl.origin}/command?token=${token}`,
          {
            method: "POST",
            headers: jsonHeaders("context-command-3"),
            body: JSON.stringify({
              kind: "select_session",
              sessionId: state.activeSessionId,
            }),
          },
        );
        const selectionState = await selectionResponse.json() as ChatDialogState;
        assert.match(selectionState.contextSummary, /Arrangement selection/);
        assert.equal(selectionState.liveContext.availability, "available");
        assert.equal(selectionState.liveContext.value.origin, "arrangement-selection");
        assert.deepEqual(selectionState.liveContext.value.details, ['MIDI track "Bass renamed"']);

        context.application.song.tracks.splice(0, 1);
        const unavailable = await (
          await fetch(`${chatUrl.origin}/state?token=${token}`)
        ).json() as ChatDialogState;
        assert.match(unavailable.contextSummary, /Live object.*unavailable/i);
        assert.deepEqual(unavailable.liveContext, {
          sessionId: state.activeSessionId, availability: "unavailable", label: "Bass",
        });
      },
    },
  };
  const interaction = arrangementSelectionInteractionContext(
    context as never,
    {
      selected_lanes: [track.handle],
      time_selection_start: 8,
      time_selection_end: 16,
    } as never,
  );

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    discoverAgentAudioTapListeners: async () => [],
    requestModelTurn: async (request) => {
      modelLiveContext = request.liveContext;
      return { content: "Selection received.", toolCalls: [] };
    },
  });
});

test("restoring a historical Session binds only that Session to the current selection", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-selection-restore-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const historical = await createSession(directory, {
    title: "Historical arrangement work",
    projectKey: "previous-activation",
    scope: { kind: "track", identity: "old-track", label: "Bass" },
  });
  const bass = fakeMidiTrack(101n, "Bass");
  const context = {
    application: {
      song: { handle: { id: 1n }, tracks: [bass], scenes: [] },
    },
    environment: { storageDirectory: directory },
    getObjectFromHandle: () => bass,
    ui: {
      showModalDialog: async (url: string) => {
        const chatUrl = new URL(url);
        const token = chatUrl.searchParams.get("token");
        const endpoint = (pathname: string) =>
          `${chatUrl.origin}${pathname}?token=${token}`;
        const initial = await (await fetch(endpoint("/state"))).json() as ChatDialogState;
        assert.match(initial.contextSummary, /Arrangement selection: beats 4 to 12/);
        assert.notEqual(initial.activeSessionId, historical.id);
        assert.equal(initial.liveContext.sessionId, initial.activeSessionId);
        assert.deepEqual(initial.previousSessions[0]?.scope, historical.scope);

        const restoredResponse = await fetch(endpoint("/command"), {
          method: "POST",
          headers: jsonHeaders("context-command-4"),
          body: JSON.stringify({
            kind: "restore_session",
            sessionId: historical.id,
          }),
        });
        const restored = await restoredResponse.json() as ChatDialogState;
        assert.equal(restored.activeSessionId, historical.id);
        assert.match(restored.contextSummary, /Arrangement selection: beats 4 to 12/);
        assert.deepEqual(restored.liveContext, {
          ...initial.liveContext, sessionId: historical.id,
        });
        assert.deepEqual(
          restored.sessions.find((session) => session.id === historical.id)?.scope,
          { kind: "track", identity: "101", label: "Bass" },
        );

        const ordinarySession = await createSession(directory, {
          title: "Ordinary Bass Session",
          projectKey: restored.sessions[0]!.projectKey,
          scope: { kind: "track", identity: "101", label: "Bass" },
        });
        const ordinaryResponse = await fetch(endpoint("/command"), {
          method: "POST",
          headers: jsonHeaders("context-command-5"),
          body: JSON.stringify({
            kind: "select_session",
            sessionId: ordinarySession.id,
          }),
        });
        const ordinary = await ordinaryResponse.json() as ChatDialogState;
        assert.match(ordinary.contextSummary, /Arrangement selection: beats 4 to 12/);
        assert.equal(ordinary.liveContext.availability, "available");
        assert.equal(ordinary.liveContext.sessionId, ordinarySession.id);
        assert.equal(ordinary.liveContext.value.origin, "arrangement-selection");
      },
    },
  };
  const interaction = arrangementSelectionInteractionContext(
    context as never,
    {
      selected_lanes: [bass.handle],
      time_selection_start: 4,
      time_selection_end: 12,
    } as never,
  );

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
  });
});

test("current Arrangement selection supersedes an older Clip Session for AgentAudioTap capture", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "live-smith-current-selection-capture-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await saveSavedProfile(directory, profile());
  const guitar = fakeMidiTrack(109n, "9 Guitar");
  let captureWindow: unknown;
  let modelLiveContext = "";
  const context = {
    application: {
      song: { handle: { id: 1n }, tracks: [guitar], scenes: [] },
    },
    environment: { storageDirectory: directory },
    getObjectFromHandle: () => guitar,
    ui: {
      showModalDialog: async (url: string) => {
        const dialog = endpoint(url);
        const initial = await state(dialog);
        assert.match(initial.contextSummary, /Arrangement selection: beats 116 to 128/);
        const clipSession = await createSession(directory, {
          title: "9 Guitar",
          projectKey: initial.sessions[0]!.projectKey,
          scope: { kind: "clip", identity: "clip-9-guitar", label: "9 Guitar" },
        });
        assert.notEqual(initial.activeSessionId, clipSession.id);

        const selectedResponse = await fetch(dialog.endpoint("/command"), {
          method: "POST",
          headers: jsonHeaders("context-command-clip-session"),
          body: JSON.stringify({
            kind: "select_session",
            sessionId: clipSession.id,
          }),
        });
        const selected = await selectedResponse.json() as ChatDialogState;
        assert.equal(selected.activeSessionId, clipSession.id);
        assert.match(selected.contextSummary, /Arrangement selection: beats 116 to 128/);
        assert.deepEqual(selected.liveContext, {
          sessionId: clipSession.id,
          availability: "available",
          value: {
            origin: "arrangement-selection", objectKind: "other", title: "Arrangement selection",
            details: ['MIDI track "9 Guitar"'],
            range: { coordinate: "arrangement-beats", start: 116, end: 128 },
          },
        });

        const send = await fetch(dialog.endpoint("/send"), {
          method: "POST",
          headers: jsonHeaders("context-send-clip-session"),
          body: JSON.stringify({
            prompt: "Capture AgentAudioTap for this selected section",
            sessionId: clipSession.id,
          }),
        });
        assert.equal(send.status, 200);
        assert.match(modelLiveContext, /Arrangement selection: beats 116 to 128/);

        const captureResponse = await fetch(dialog.endpoint("/command"), {
          method: "POST",
          headers: jsonHeaders("context-command-capture-main"),
          body: JSON.stringify({
            kind: "capture_main_for_analysis",
            sessionId: clipSession.id,
            startBeat: 4,
            endBeat: 12,
          }),
        });
        assert.equal(captureResponse.status, 200);
        assert.deepEqual(captureWindow, { startBeat: 116, endBeat: 128 });
      },
    },
  };
  const interaction = arrangementSelectionInteractionContext(
    context as never,
    {
      selected_lanes: [guitar.handle],
      time_selection_start: 116,
      time_selection_end: 128,
    } as never,
  );

  await runAgentFlow(context as never, interaction, {
    renderHtml: () => "<html></html>",
    requestModelTurn: async (request) => {
      modelLiveContext = request.liveContext;
      return { content: "Selection received.", toolCalls: [] };
    },
    discoverAgentAudioTapListeners: async () => [{
      tapId: "tap_main_123", trackName: "Main", trackType: "main",
      canonicalParent: "live_set master_track", updatedAt: "2026-10-08T00:00:00.000Z",
    }],
    captureArrangementWithAgentAudioTap: async (input) => {
      captureWindow = input.window;
      return {
        artifactRef: "audio_artifact_123",
        captureId: "tapcapture_123",
        durationSeconds: 4,
        channels: 2,
      };
    },
  });
});
for (const [kind, operation] of [
  ["track", "send"],
  ["clip", "send"],
  ["device", "send"],
  ["selection", "send"],
  ["clip-slot-selection", "send"],
  ["track", "compact"],
] as const) {
  test(`${operation} preserves the conversation after its ${kind} context is removed`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-removed-context-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    await saveSavedProfile(directory, profile());
    const track = fakeMidiTrack(101n, "Lead");
    const otherName = kind === "track" ? "Lead" : "Other";
    const other = fakeMidiTrack(102n, otherName);
    const clip = Object.defineProperties(Object.create(MidiClip.prototype), {
      handle: { value: { id: 201n } }, parent: { value: track }, name: { value: "Phrase" },
      notes: { value: [] }, startTime: { value: 0 }, endTime: { value: 4 }, duration: { value: 4 },
      startMarker: { value: 0 }, endMarker: { value: 4 }, looping: { value: false },
      muted: { value: false }, color: { value: 0 },
    }) as MidiClip<"1.0.0">;
    const device = Object.defineProperties(Object.create(Device.prototype), {
      handle: { value: { id: 301n } }, parent: { value: track },
      name: { value: "Operator" }, parameters: { value: [] },
    }) as Device<"1.0.0">;
    const slot = Object.defineProperties(Object.create(ClipSlot.prototype), {
      handle: { value: { id: 401n } }, parent: { value: track }, clip: { value: null },
    }) as ClipSlot<"1.0.0">;
    if (kind === "clip") track.arrangementClips.push(clip);
    if (kind === "device") track.devices.push(device);
    if (kind === "clip-slot-selection") track.clipSlots.push(slot);
    const scope = kind === "clip"
      ? { kind: "clip" as const, identity: "201", label: "Phrase" }
      : kind === "device"
        ? { kind: "object" as const, identity: "301", label: "Operator" }
        : { kind: "track" as const, identity: "101", label: "Lead" };
    let modelCalls = 0;
    let unavailableSummary = "";
    const context = {
      application: { song: { handle: { id: 1n }, tracks: [track, other], scenes: [] } },
      environment: { storageDirectory: directory },
      getObjectFromHandle: (handle: { id: bigint }) =>
        handle.id === slot.handle.id ? slot : handle.id === track.handle.id ? track : other,
      ui: { showModalDialog: async (url: string) => {
        const dialog = endpoint(url);
        const initial = await state(dialog);
        const sessionId = initial.activeSessionId;
        assert.equal(initial.liveContext.availability, "available");
        const send = (prompt: string, id: string) => fetch(dialog.endpoint("/send"), {
          method: "POST", headers: jsonHeaders(id), body: JSON.stringify({ prompt, sessionId }),
        });
        const first = await send("Remember this conversation", "before-removal");
        assert.equal(first.status, 200, await first.text());

        if (kind === "clip") track.arrangementClips.splice(0, 1);
        else if (kind === "device") track.devices.splice(0, 1);
        else if (kind === "clip-slot-selection") track.clipSlots.splice(0, 1);
        else context.application.song.tracks.splice(kind === "selection" ? 1 : 0, 1);
        const removed = await state(dialog);
        assert.equal(removed.activeSessionId, sessionId);
        assert.equal(removed.liveContext.availability, "unavailable");
        unavailableSummary = removed.contextSummary;

        const response = operation === "send"
          ? await send("Continue this conversation", "after-removal")
          : await fetch(dialog.endpoint("/command"), {
              method: "POST", headers: jsonHeaders("compact-after-removal"),
              body: JSON.stringify({ kind: "compact_session", sessionId }),
            });
        assert.equal(response.status, 200, await response.text());
        const events = await loadSessionEvents(directory, sessionId);
        assert.ok(events.some((event) => event.kind === "user" && event.content === "Remember this conversation"));
        if (operation === "send") {
          assert.ok(events.some((event) => event.kind === "assistant" && event.content === "Conversation continued."));
          assert.deepEqual(events.filter((event) => event.kind === "tool_call").map((event) => event.name), [
            "inspect_current_object", "inspect_track", "inspect_track", "apply_live_actions",
          ]);
          const errors = events.filter((event) => event.kind === "error");
          assert.match(errors[0]!.content, /No selected Live object/);
          assert.match(errors[1]!.content, /No target track/);
          assert.match(events.find((event) => event.kind === "tool_result" && event.name === "inspect_track")!.content, /MIDI track "Lead"/);
          assert.match(errors[2]!.content, /No target track/);
          assert.equal(events.some((event) => event.kind === "apply_requested"), false);
        } else {
          assert.equal(events.at(-1)?.kind, "compaction");
          assert.equal(events.at(-1)?.content, "Conversation checkpoint.");
        }
        const current = await state(dialog);
        assert.equal(current.activeSessionId, sessionId);
        assert.equal(current.liveContext.availability, "unavailable");
        assert.deepEqual((await listSessions(directory)).find((entry) => entry.id === sessionId)?.scope, initial.sessions[0]!.scope);
        assert.equal(track.name, "Lead");
        assert.equal(other.name, otherName);
      } },
    };
    const interaction = kind === "selection"
      ? arrangementSelectionInteractionContext(context as never, {
          selected_lanes: [track.handle, other.handle], time_selection_start: 0, time_selection_end: 4,
        } as never)
      : kind === "clip-slot-selection"
        ? clipSlotSelectionInteractionContext(context as never, { selected_clip_slots: [slot.handle] } as never)
        : interactionContextForScope(context as never, scope)!;
    await runAgentFlow(context as never, interaction, {
      renderHtml: () => "<html></html>",
      requestModelTurn: async (request) => {
        modelCalls += 1;
        if (modelCalls === 1) return { content: "Conversation saved.", toolCalls: [] };
        assert.ok(JSON.stringify(request.history).includes("Remember this conversation"));
        assert.ok(request.liveContext.startsWith(unavailableSummary));
        if (operation === "compact") return { content: "Conversation checkpoint.", toolCalls: [] };
        const toolCalls = [
          { id: "current", name: "inspect_current_object", arguments: "{}" },
          { id: "implicit", name: "inspect_track", arguments: "{}" },
          { id: "explicit", name: "inspect_track", arguments: JSON.stringify({ trackName: "Lead" }) },
          { id: "apply", name: "apply_live_actions", arguments: JSON.stringify({
            message: "Rename the default target", actions: [{ type: "rename_track", newName: "Changed" }],
          }) },
        ];
        const toolCall = toolCalls[modelCalls - 2];
        if (toolCall) return { content: "", toolCalls: [toolCall] };
        return { content: "Conversation continued.", toolCalls: [] };
      },
    });
    assert.equal(modelCalls, operation === "compact" ? 2 : 6);
  });
}

interface DialogEndpoint {
  endpoint(pathname: string): string;
}

function endpoint(chatUrl: string): DialogEndpoint {
  const url = new URL(chatUrl);
  const token = url.searchParams.get("token")!;
  return {
    endpoint: (pathname) =>
      `${url.origin}${pathname}?token=${encodeURIComponent(token)}`,
  };
}

async function state(
  dialog: DialogEndpoint,
  sessionId?: string,
): Promise<ChatBridgeState> {
  const url = dialog.endpoint("/state") + (sessionId === undefined
    ? ""
    : `&sessionId=${encodeURIComponent(sessionId)}`);
  return await (await fetch(url)).json() as ChatBridgeState;
}

function jsonHeaders(id: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Live-Smith-Command-Id": id,
    "X-Live-Smith-Send-Id": id,
  };
}

function fakeMidiTrack(id = 1n, name = "Lead"): MidiTrack<"1.0.0"> {
  return Object.defineProperties(Object.create(MidiTrack.prototype), {
    handle: { enumerable: true, value: { id } },
    name: { enumerable: true, value: name, writable: true },
    mute: { enumerable: true, value: false },
    solo: { enumerable: true, value: false },
    mutedViaSolo: { enumerable: true, value: false },
    arm: { enumerable: true, value: false },
    groupTrack: { enumerable: true, value: null },
    arrangementClips: { enumerable: true, value: [] },
    takeLanes: { enumerable: true, value: [] },
    clipSlots: { enumerable: true, value: [] },
    devices: { enumerable: true, value: [] },
  }) as MidiTrack<"1.0.0">;
}

function profile(): SavedProfile {
  return {
    id: "profile-1",
    name: "Provider",
    connection: {
      kind: "direct-api",
      apiFamily: "openai",
      apiMode: "responses",
      baseUrl: "https://provider.test/v1",
      apiKey: "test-key",
    },
    defaultModel: "model-a",
    models: [{
      model: "model-a",
      parameters: {
        maxOutputTokens: 1_000,
        reasoning: { mode: "default" },
      },
      advanced: {},
    }],
  };
}
