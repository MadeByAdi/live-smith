import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import vm from "node:vm";

type OutletMessage = readonly unknown[];

test("a stale end-position observation cannot start or stop a bounded listen before the seek is observed", async () => {
  const source = await fs.readFile(path.resolve("m4l/agent_audio_tap_registry.js"), "utf8");
  let observedSongTime = 336;
  let isPlaying = 0;
  const outlets: OutletMessage[] = [];

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
      if (property === "start_time") return [320];
      if (property === "name") return ["Main"];
      if (property === "is_foldable") return [0];
      return [0];
    }
    getstring(property: string) { return property === "name" ? "Main" : ""; }
    set(property: string, value: number) {
      if (property === "is_playing") isPlaying = value;
      // Simulate Live's asynchronous seek: setting current_song_time does not
      // immediately change what the next observation reports.
    }
    call(method: string) { if (method === "start_playing") isPlaying = 1; if (method === "stop_playing") isPlaying = 0; }
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
    startBeat: 320, endBeat: 336, path: "/private/tmp/capture.wav",
  };

  script.armListen(capture);
  script.beginListen(capture);

  assert.equal(outlets.some((message) => message[0] === 0 && message[1] === 1), false);
  assert.equal(isPlaying, 0);

  observedSongTime = 320;
  script.checkTransportPosition();

  assert.equal(outlets.some((message) => message[0] === 0 && message[1] === 1), true);
  assert.equal(isPlaying, 1);
});
