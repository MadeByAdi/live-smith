import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import vm from "node:vm";

type OutletMessage = readonly unknown[];

test("AgentAudioTap waits for the bounded start before monitoring the selected end and restores transport", async () => {
  const source = await fs.readFile(path.resolve("m4l/agent_audio_tap_registry.js"), "utf8");
  let observedSongTime = 116;
  let isPlaying = 0;
  let startTime = 64;
  const outlets: OutletMessage[] = [];
  const calls: string[] = [];
  const sets: Array<readonly [string, number]> = [];

  class FakeFile {
    isopen = true;
    position = 0;
    eof = 0;
    constructor(_fileName: string, _mode: string) {}
    readstring(_max: number) { return ""; }
    writestring(_value: string) {}
    close() {}
  }
  class FakeTask {
    interval = 0;
    constructor(private readonly callback: () => void) {}
    schedule(_milliseconds: number) {}
    repeat() {}
    invoke() { this.callback(); }
  }
  class FakeLiveApi {
    unquotedpath = "live_set master_track";
    path = this.unquotedpath;
    property = "";
    constructor(_callback?: unknown, _path?: string) {}
    goto(_path: string) {}
    get(property: string) {
      if (property === "current_song_time") return [observedSongTime];
      if (property === "is_playing") return [isPlaying];
      if (property === "start_time") return [startTime];
      if (property === "name") return ["Main"];
      if (property === "is_foldable") return [0];
      return [0];
    }
    getstring(property: string) { return property === "name" ? "Main" : ""; }
    set(property: string, value: number) {
      sets.push([property, value]);
      if (property === "start_time") startTime = value;
      if (property === "is_playing") isPlaying = value;
      // Simulate Live's asynchronous seek: setting current_song_time does not
      // immediately change what the next observation reports.
    }
    call(method: string) {
      calls.push(method);
      if (method === "start_playing") isPlaying = 1;
      if (method === "stop_playing") isPlaying = 0;
    }
  }

  const context = vm.createContext({
    autowatch: 0, inlets: 0, outlets: 0, jsarguments: ["js", "command.json"],
    File: FakeFile, Task: FakeTask, LiveAPI: FakeLiveApi,
    outlet: (...values: unknown[]) => { outlets.push(values); },
    arrayfromargs: (...values: unknown[]) => values,
    messagename: "",
    Math, Date, JSON, String, Number, RegExp, Array, isFinite,
  });
  vm.runInContext(source, context, { filename: "agent_audio_tap_registry.js" });
  const script = context as unknown as {
    song: unknown;
    armListen(value: unknown): void;
    beginListen(value: unknown): void;
    checkTransportPosition(): void;
  };
  script.song = new FakeLiveApi();
  const capture = {
    id: "command_123", captureId: "capture_123", windowId: "window_123",
    startBeat: 92, endBeat: 99, path: "/private/tmp/capture.wav",
  };

  script.armListen(capture);
  script.beginListen(capture);
  script.checkTransportPosition();

  assert.equal(outlets.some((message) => message[0] === 0 && message[1] === 1), false);
  assert.equal(isPlaying, 0);
  assert.deepEqual(calls, []);
  assert.deepEqual(sets.slice(0, 2), [["start_time", 92], ["current_song_time", 92]]);

  observedSongTime = 91.4;
  script.checkTransportPosition();

  assert.equal(outlets.some((message) => message[0] === 0 && message[1] === 1), false);
  assert.deepEqual(calls, []);

  observedSongTime = 92.1;
  script.checkTransportPosition();

  assert.equal(outlets.filter((message) => message[0] === 0 && message[1] === 1).length, 1);
  assert.equal(isPlaying, 1);
  assert.deepEqual(calls, ["start_playing"]);

  observedSongTime = 98.75;
  script.checkTransportPosition();

  assert.equal(outlets.filter((message) => message[0] === 0 && message[1] === 0).length, 0);
  assert.deepEqual(calls, ["start_playing"]);

  observedSongTime = 99;
  script.checkTransportPosition();
  observedSongTime = 100.5;
  script.checkTransportPosition();

  assert.equal(outlets.filter((message) => message[0] === 0 && message[1] === 0).length, 1);
  assert.deepEqual(calls, ["start_playing", "stop_playing"]);
  assert.equal(isPlaying, 0);
  assert.deepEqual(sets.slice(-2), [["current_song_time", 116], ["start_time", 64]]);
});

test("tracked AgentAudioTap runtime devices contain the seek-gated end-stop lifecycle", async () => {
  const devices = [
    "m4l/AgentAudioTap Registry Proof Native Project/AgentAudioTap Registry Proof Auto Stop.amxd",
    "m4l/AgentAudioTap Registry Proof Native Project/patchers/AgentAudioTap Registry Proof Transport Trace.amxd",
  ];
  for (const device of devices) {
    const content = (await fs.readFile(path.resolve(device))).toString("latin1");
    assert.match(content, /listenAwaitingSeek/u, device);
    assert.match(content, /seek_observed/u, device);
    assert.match(content, /start_playing_requested/u, device);
    assert.match(content, /reached_end/u, device);
    assert.match(content, /song\.call\("stop_playing"\)/u, device);
    assert.match(content, /song\.set\("current_song_time", listenSnapshot\.currentSongTime\)/u, device);
  }
});
