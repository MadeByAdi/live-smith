import assert from "node:assert/strict";
import test from "node:test";
import * as vm from "node:vm";
import * as esbuild from "esbuild";

const mockModules: Record<string, string> = {
  "@ableton-extensions/sdk": "export const initialize = activation => activation.context;",
  "./app/window-hosts.js": "export const createWindowHostController = () => ({ start: () => __probe.start(), open: value => __probe.open(value) });",
  "node:console": "export const error = value => __probe.errors.push(value);",
  "./app/agent-flow.js": "export const showAgentError = () => { throw new Error('Unexpected dialog'); };",
  "./app/agent-audio-tap.js": "export const ensureAgentAudioTapRegistryDirectory = async () => {};",
  "./app/live-mutation-queue.js": "export class LiveMutationQueue {}",
  "./live/context.js": `export const objectInteractionContext = (_context, value) => ({ kind: 'object', value });
    export const arrangementSelectionInteractionContext = (_context, value) => ({ kind: 'arrangement', value });
    export const clipSlotSelectionInteractionContext = (_context, value) => ({ kind: 'slots', value });`,
  "./runtime/oauth-browser.js": "export const openOAuthAuthorizationUrl = async () => {};",
  "./runtime/vst3-handoff.js": "export const openChatInVst3 = async () => {};",
  "./runtime/native-isolation.js": "export const isolatedNativeBuild = __probe.isolated; export const assertIsolatedNativeStorage = value => __probe.assertStorage(value);",
};

async function bundledActivate() {
  const result = await esbuild.build({ entryPoints: ["src/extension.ts"], bundle: true,
    platform: "node", format: "cjs", write: false, logLevel: "silent",
    plugins: [{ name: "activation-fixture", setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => args.importer && mockModules[args.path]
        ? { path: args.path, namespace: "activation-fixture" } : undefined);
      build.onLoad({ filter: /.*/, namespace: "activation-fixture" }, (args) =>
        ({ contents: mockModules[args.path]!, loader: "js" }));
    } }],
  });
  return result.outputFiles[0]!.text;
}

for (const fails of [false, true]) test(`native activation starts silently and preserves commands when startup ${fails ? "fails" : "succeeds"}`, async () => {
  const source = await bundledActivate();
  const commands = new Map<string, (value: unknown) => void>();
  const actions: string[] = [];
  const opened: unknown[] = [];
  let starts = 0;
  const probe = {
    errors: [] as string[],
    start: async () => { starts++; if (fails) throw new Error("private handoff detail"); },
    open: async (value: unknown) => { opened.push(value); },
    assertStorage: (_value: unknown) => {},
    isolated: false,
  };
  const context = { environment: { storageDirectory: "/isolated-test" },
    commands: { registerCommand: (id: string, callback: (value: unknown) => void) => { commands.set(id, callback); } },
    ui: { registerContextMenuAction: async (scope: string) => { actions.push(scope); } } };
  const module = { exports: {} as { activate?: (activation: unknown) => void } };
  vm.runInNewContext(source, { module, exports: module.exports, __probe: probe }, { timeout: 5_000 });
  assert.equal(typeof module.exports.activate, "function");
  module.exports.activate!({ context });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal(commands.size, 3);
  assert.equal(actions.length, 12);
  assert.deepEqual(probe.errors, fails ? ["Live Smith bridge startup failed."] : []);
  commands.get("live-smith.ask-object")!({ id: "selected-track" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(opened)), [{ kind: "object", value: { id: "selected-track" } }]);
});

test("rejected isolated storage fails closed before bridge startup or command registration", async () => {
  const source = await bundledActivate();
  const probe = { errors: [] as string[], start: () => { throw new Error("must not start"); },
    open: () => { throw new Error("must not open"); },
    isolated: true,
    assertStorage: () => { throw new Error("private storage path"); } };
  const context = { environment: { storageDirectory: "/ambiguous" },
    commands: { registerCommand: () => { throw new Error("must not register"); } } };
  const module = { exports: {} as { activate?: (activation: unknown) => void } };
  vm.runInNewContext(source, { module, exports: module.exports, __probe: probe }, { timeout: 5_000 });
  module.exports.activate!({ context });
  assert.deepEqual(probe.errors, ["Live Smith isolated native storage validation failed."]);
});

test("isolated native commands and context labels do not impersonate production", async () => {
  const source = await bundledActivate();
  const commands: string[] = [];
  const actions: Array<[string, string]> = [];
  const probe = { errors: [] as string[], isolated: true, start: async () => {}, open: async () => {},
    assertStorage: () => {} };
  const context = { environment: { storageDirectory: "/isolated-test" },
    commands: { registerCommand: (id: string) => { commands.push(id); } },
    ui: { registerContextMenuAction: async (_scope: string, label: string, id: string) => { actions.push([label, id]); } } };
  const module = { exports: {} as { activate?: (activation: unknown) => void } };
  vm.runInNewContext(source, { module, exports: module.exports, __probe: probe }, { timeout: 5_000 });
  module.exports.activate!({ context });
  assert.equal(commands.length, 3);
  assert.equal(actions.length, 12);
  assert.ok(commands.every((id) => id.startsWith("t7-live-smith-native-dev.")));
  assert.ok(actions.every(([label, id]) => label.startsWith("Ask T7 Live Smith Native Dev") && id.startsWith("t7-live-smith-native-dev.")));
});
