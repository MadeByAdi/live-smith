import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import * as vm from "node:vm";
import * as esbuild from "esbuild";

import { assertIsolatedNativeStorage, isolatedNativeBuild } from "../../src/runtime/native-isolation.js";
import { agentAudioTapRegistryDirectory } from "../../src/app/agent-audio-tap.js";

const isolatedId = "t7-startup-isolation-lab.t7-live-smith-native-dev-20261012";

async function isolatedModule(entry: string, defines: Record<string, string>) {
  const result = await esbuild.build({ entryPoints: [entry], bundle: true, platform: "node",
    format: "cjs", write: false, logLevel: "silent", define: defines });
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(result.outputFiles[0]!.text, {
    module, exports: module.exports, require: createRequire(import.meta.url), process,
  }, { timeout: 5_000 });
  return module.exports;
}

test("ordinary dev mode keeps the existing storage and audio tap paths", () => {
  assert.equal(isolatedNativeBuild, false);
  assert.doesNotThrow(() => assertIsolatedNativeStorage(undefined));
  assert.equal(agentAudioTapRegistryDirectory(), path.join(tmpdir(), "Ableton Extensions", "a"));
});

test("isolated native mode rejects ambiguous and production storage before activation", async () => {
  const isolated = await isolatedModule("src/runtime/native-isolation.ts", {
    __LIVE_SMITH_ISOLATED_NATIVE_BUILD__: "true",
  });
  const guard = isolated.assertIsolatedNativeStorage as (value?: string) => void;
  assert.equal(isolated.isolatedNativeBuild, true);
  assert.throws(() => guard(undefined), /isolated Live Smith storage identity/i);
  assert.throws(() => guard("/Users/test/Library/Application Support/Ableton/Extensions Data/sam-kuler.live-smith"), /isolated Live Smith storage identity/i);
});

test("isolated handoff writes only to its own identity", async () => {
  const isolated = await isolatedModule("src/runtime/vst3-handoff.ts", {
    __LIVE_SMITH_HANDOFF_ID__: JSON.stringify(isolatedId),
  });
  const writes: string[] = [];
  const create = isolated.createVst3HandoffOpener as (options: Record<string, unknown>) => (url: string) => Promise<void>;
  const open = create({ homeDirectory: "/Users/test", mkdir: async () => {},
    writeFile: async (file: string) => { writes.push(file); } });
  await open("http://127.0.0.1:4620/chat?launch=123e4567-e89b-12d3-a456-426614174000");
  assert.deepEqual(writes, [path.join("/Users/test/Library/Application Support/Ableton/Extensions Data", isolatedId, "vst3-bridge-url.txt")]);
});

test("isolated audio tap registry has a distinct directory", async () => {
  const isolated = await isolatedModule("src/app/agent-audio-tap.ts", {
    __LIVE_SMITH_ISOLATED_NATIVE_BUILD__: "true",
  });
  const registry = isolated.agentAudioTapRegistryDirectory as () => string;
  assert.equal(path.basename(path.dirname(registry())), isolatedId);
  assert.notEqual(registry(), agentAudioTapRegistryDirectory());
});

test("isolated mode rejects Smith Companion before native launch", async () => {
  const isolated = await isolatedModule("src/runtime/smith-companion.ts", {
    __LIVE_SMITH_ISOLATED_NATIVE_BUILD__: "true",
    __LIVE_SMITH_COMPANION_CAPSULE__: JSON.stringify("{}"),
  });
  let launches = 0;
  const create = isolated.createSmithCompanionOpener as (options: Record<string, unknown>) => (url: string) => Promise<void>;
  const open = create({ platform: "darwin", launch: async () => { launches++; } });
  await assert.rejects(open("http://127.0.0.1:4620/chat?launch=123e4567-e89b-12d3-a456-426614174000"),
    /unavailable in the isolated native test/i);
  assert.equal(launches, 0);
});
