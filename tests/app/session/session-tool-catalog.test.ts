import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { URL } from "node:url";

import { strToU8, zipSync } from "fflate/browser";

import type { LiveInteractionContext } from "../../../src/live/context.js";
import { installPlugin, setPluginEnabled, setPluginMcpServerApproved } from "../../../src/storage/plugins.js";
import { createSession } from "../../../src/storage/sessions.js";
import { saveGlobalSettings } from "../../../src/storage/settings.js";
import { appendSessionEvent } from "../../../src/storage/events.js";
import { chatDialogStateForWire, type ChatDialogState } from "../../../src/ui/chat-state.js";
import { runAgentFlow } from "../../../src/app/agent-flow.js";
import { parseCommandInput } from "../../../src/app/chat/chat-bridge-http.js";
import { liveContextPresentationFixture } from "../context/support/live-context.test-harness.js";
import { loadSessionToolCatalog, sessionToolCatalogOwner } from "../../../src/app/session/session-tool-catalog.js";
import { SunoSessions } from "../../../src/storage/suno-sessions.js";
import { saveIntegrationConnection } from "../plugins/support/integration-connection-test-helpers.js";
import { connection, fixtureToken } from "../audio/support/audio-retrieval-test-helpers.js";

const serverSource = String.raw`
import fs from "node:fs";
import readline from "node:readline";
fs.writeFileSync(process.argv[2], "started");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = async (value) => {
  if (value.result?.tools && process.argv[4]) {
    fs.appendFileSync(process.argv[4], "list\n");
    while (!fs.existsSync(process.argv[5])) await new Promise(resolve => setTimeout(resolve, 10));
  }
  process.stdout.write(JSON.stringify(value) + "\n");
};
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "server/discover") send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "legacy" } });
  else if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: {
    protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "catalog-fixture", version: "1" }
  } });
  else if (request.method === "tools/list") send({ jsonrpc: "2.0", id: request.id, result: { tools: [{
    name: "convert_audio", description: "Convert one audio asset", inputSchema: { type: "object", properties: {} }
  }, {
    name: "long_description", description: "x".repeat(700), inputSchema: { type: "object", properties: {} }
  }] } });
  else if (request.method === "tools/call") fs.writeFileSync(process.argv[3], "called");
});
`;

function packageBytes(startedPath: string, calledPath: string, gatePaths: string[] = []): Uint8Array {
  return zipSync({
    "plugin.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "catalog-fixture",
    })),
    "mcp.json": strToU8(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { local: { type: "stdio", command: "node",
        args: ["${PLUGIN_ROOT}/server.mjs", startedPath, calledPath, ...gatePaths] } },
    })),
    "server.mjs": strToU8(serverSource),
  });
}

function route(url: string, pathname: string): URL {
  const endpoint = new URL(url);
  endpoint.pathname = pathname;
  return endpoint;
}

test("tool catalog command accepts only its Session identifier", () => {
  const input = { kind: "load_session_tools", sessionId: "session-one" };
  assert.deepEqual(parseCommandInput(input), input);
  for (const invalid of [
    { ...input, sessionId: "" },
    { ...input, sessionId: "../other" },
    { ...input, apiKey: "synthetic-secret" },
    { ...input, profileId: "profile-one" },
  ]) assert.throws(() => parseCommandInput(invalid));
});

test("tool catalog ownership changes with Session, Profile, Plugin, and Connection state", () => {
  const state = {
    activeSessionId: "session-one", activeProfileRevision: null, runtimeProfile: null,
    integrationConnections: { revision: "0", connections: [] }, plugins: [],
    sunoAccounts: [], audioJobs: [], events: [], settings: { networkProxyRevision: "0" },
  } as unknown as ChatDialogState;
  const owner = sessionToolCatalogOwner(state);
  const absentMedia = { ...state };
  delete absentMedia.sunoAccounts;
  delete absentMedia.audioJobs;
  assert.equal(sessionToolCatalogOwner(absentMedia), owner);
  for (const changed of [
    { ...state, activeSessionId: "session-two" },
    { ...state, activeProfileRevision: "a".repeat(64) },
    { ...state, runtimeProfile: { selection: { model: "other-model" } } },
    { ...state, integrationConnections: { revision: "1", connections: [] } },
    { ...state, plugins: [{ id: "fixture", enabled: true, mcpServers: [{ id: "server" }], issues: [] }] },
    { ...state, audioJobs: [{ id: "job-one", status: "completed", outputs: [] }] },
    { ...state, settings: { networkProxyRevision: "1" } },
  ] as ChatDialogState[]) assert.notEqual(sessionToolCatalogOwner(changed), owner);
  assert.equal(sessionToolCatalogOwner({ ...state, events: [{ id: "progress" }] } as ChatDialogState), owner);
  const server = { id: "server", type: "stdio", approved: true };
  const withPlugin = { ...state, plugins: [{ id: "fixture", enabled: true, mcpServers: [server], issues: [] }] } as unknown as ChatDialogState;
  assert.equal(sessionToolCatalogOwner(withPlugin), sessionToolCatalogOwner({ ...withPlugin,
    plugins: [{ ...withPlugin.plugins[0]!, mcpServers: [{ approved: true, type: "stdio", id: "server" }] }],
  } as ChatDialogState), "wire projection property order does not change catalog ownership");
  for (const plugin of [
    { id: "skills", enabled: true, mcpServers: [], issues: [], skillCount: 1 },
    { id: "disabled", enabled: false, mcpServers: [{ id: "server" }], issues: [] },
  ]) assert.equal(sessionToolCatalogOwner({ ...state, plugins: [plugin] } as unknown as ChatDialogState), owner);
  const withJob = { ...state, audioJobs: [{ id: "job-one", status: "running", outputs: [] }] } as unknown as ChatDialogState;
  assert.equal(sessionToolCatalogOwner(withJob), sessionToolCatalogOwner({ ...withJob,
    audioJobs: [{ id: "job-one", status: "completed", outputs: [{ id: "audio-one" }] }],
    events: [{ id: "completed" }],
  } as ChatDialogState));
});

test("tool catalog wire projection exposes only display fields", () => {
  const projected = chatDialogStateForWire({ sessionToolCatalog: {
    sessionId: "session-one", loadedAt: "2026-09-25T00:00:00.000Z", modelToolsSupported: true,
    truncated: false, credential: "synthetic-secret",
    groups: [{ kind: "mcp", pluginId: "catalog-fixture", serverId: "local", credential: "synthetic-secret",
      tools: [{ name: "convert_audio", description: "Convert audio", credential: "synthetic-secret" }] }],
    issues: [],
  } } as unknown as ChatDialogState);
  assert.deepEqual(projected.sessionToolCatalog, {
    sessionId: "session-one", loadedAt: "2026-09-25T00:00:00.000Z", modelToolsSupported: true,
    truncated: false,
    groups: [{ kind: "mcp", pluginId: "catalog-fixture", serverId: "local",
      tools: [{ name: "convert_audio", description: "Convert audio" }] }],
    issues: [],
  });
  assert.doesNotMatch(JSON.stringify(projected), /synthetic-secret/u);
});

for (const source of ["plugin", "standalone"] as const) test(`explicit Session tool load discovers ${source} MCP names and invalidates its modal snapshot`, async (t) => {
  const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-tool-catalog-"));
  t.after(() => fs.rm(storageDirectory, { recursive: true, force: true }));
  const startedPath = path.join(storageDirectory, "mcp-started");
  const calledPath = path.join(storageDirectory, "mcp-called");
  const directConnection = {
    id: "direct-catalog", name: "Local catalog", enabled: true,
    mcp: { type: "stdio" as const, command: "node",
      args: [path.join(storageDirectory, "server.mjs"), startedPath, calledPath] },
    secrets: {}, artifactInputApproved: false, artifactOutputApproved: false,
  };
  if (source === "plugin") {
    await installPlugin(storageDirectory, packageBytes(startedPath, calledPath));
    await setPluginMcpServerApproved(storageDirectory, "catalog-fixture", "local", true);
    await setPluginEnabled(storageDirectory, "catalog-fixture", true);
  } else {
    await fs.writeFile(path.join(storageDirectory, "server.mjs"), serverSource);
    await saveGlobalSettings(storageDirectory, { integrationConnections: {
      action: "upsert", expectedRevision: "0", connection: directConnection,
    } });
  }
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"), summary: "Track: Lead", target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  let commandSequence = 0;
  await runAgentFlow({
    application: { song: { handle: { id: 1n } } },
    environment: { storageDirectory },
    ui: { showModalDialog: async (url: string) => {
      const readState = async (): Promise<ChatDialogState> => {
        const response = await fetch(route(url, "/state"));
        assert.equal(response.status, 200);
        return response.json() as Promise<ChatDialogState>;
      };
      const command = async (body: unknown): Promise<ChatDialogState> => {
        const response = await fetch(route(url, "/command"), {
          method: "POST", headers: {
            "Content-Type": "application/json",
            "X-Live-Smith-Command-Id": `tools-command-${++commandSequence}`,
          }, body: JSON.stringify(body),
        });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        return JSON.parse(text) as ChatDialogState;
      };
      const initial = await readState();
      assert.equal(initial.sessionToolCatalog, undefined, "opening the dialog does not discover MCP tools");
      await assert.rejects(fs.access(startedPath), "opening the dialog must not start MCP");
      const loaded = await command({ kind: "load_session_tools", sessionId: initial.activeSessionId });
      assert.equal(await fs.readFile(startedPath, "utf8"), "started");
      await assert.rejects(fs.access(calledPath), "loading the directory must not invoke a tool");
      const catalog = loaded.sessionToolCatalog;
      assert.ok(catalog);
      assert.equal(catalog.sessionId, initial.activeSessionId);
      assert.equal(catalog.modelToolsSupported, false, "no active Profile cannot use function tools");
      assert.ok(catalog.groups.some((group) => group.kind === "live" &&
        group.tools.some((tool) => tool.name === "inspect_current_object")));
      const mcpGroups = catalog.groups.filter((group) => group.kind === "mcp");
      assert.ok(mcpGroups.every((group) => group.tools.every((tool) => tool.panel?.fields.length === 0)));
      assert.deepEqual(mcpGroups.map((group) => ({ ...group, tools: group.tools.map(({ name, description }) => ({ name, description })) })), [{
        kind: "mcp", ...(source === "plugin" ? { pluginId: "catalog-fixture", serverId: "local" }
          : { serverId: "server", connectionId: directConnection.id, connectionName: directConnection.name }), tools: [
          { name: "convert_audio", description: "Convert one audio asset" },
          { name: "long_description", description: "x".repeat(511) + "…" },
        ],
      }]);
      assert.deepEqual(catalog.issues, []);
      assert.doesNotMatch(JSON.stringify(catalog), /synthetic-secret/u);
      assert.deepEqual((await readState()).sessionToolCatalog, catalog);
      await appendSessionEvent(storageDirectory, initial.activeSessionId, { kind: "tool_call", name: "inspect_live_set", content: "{}" });
      await appendSessionEvent(storageDirectory, initial.activeSessionId, { kind: "tool_result", name: "inspect_live_set", content: "Observed Live" });
      assert.deepEqual((await readState()).sessionToolCatalog, catalog, "ordinary tool history retains discovered schemas");
      await command({ kind: "rename_session", sessionId: initial.activeSessionId, title: "Original" });
      const nextSession = await command({ kind: "new_session" });
      assert.notEqual(nextSession.activeSessionId, initial.activeSessionId);
      assert.equal(nextSession.sessionToolCatalog, undefined);
      const returned = await command({ kind: "select_session", sessionId: initial.activeSessionId });
      assert.equal(returned.sessionToolCatalog, undefined, "switching back does not revive a stale snapshot");
      assert.ok((await command({ kind: "load_session_tools", sessionId: initial.activeSessionId })).sessionToolCatalog);
      const disabled = await command(source === "plugin"
        ? { kind: "set_plugin_enabled", pluginId: "catalog-fixture", enabled: false }
        : { kind: "save_global_settings", integrationConnections: {
          action: "upsert", expectedRevision: "1", connection: { ...directConnection, enabled: false },
        } });
      assert.equal(disabled.sessionToolCatalog, undefined);
      assert.equal((await readState()).sessionToolCatalog, undefined);
    } },
  } as never, interaction, { renderHtml: () => "<html></html>" });
});

test("directory response refreshes local suggestions recorded during MCP discovery", async (t) => {
  const directory = await fs.mkdtemp("/private/tmp/live-smith-catalog-race-");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const entered = path.join(directory, "entered"), release = path.join(directory, "release");
  await installPlugin(directory, packageBytes(path.join(directory, "started"), path.join(directory, "called"), [entered, release]));
  await setPluginMcpServerApproved(directory, "catalog-fixture", "local", true);
  await setPluginEnabled(directory, "catalog-fixture", true);
  await saveIntegrationConnection(directory, "0", connection);
  await new SunoSessions(directory).save(connection.id, { accountId: "user_fixture", clientToken: fixtureToken("catalog-race") });
  const interaction: LiveInteractionContext = {
    presentation: liveContextPresentationFixture("Lead"), summary: "Track: Lead", target: {},
    scope: { kind: "track", identity: "track-1", label: "Lead" },
  };
  interaction.selectionContext = { refresh: () => interaction };
  await runAgentFlow({ application: { song: { handle: { id: 1n } } }, environment: { storageDirectory: directory },
    ui: { showModalDialog: async (url: string) => {
      const initial = await (await fetch(route(url, "/state"))).json() as ChatDialogState;
      const loading = fetch(route(url, "/session-tools"), { method: "POST", headers: { "Content-Type": "application/json", "X-Live-Smith-Command-Id": "catalog-race-load" },
        body: JSON.stringify({ kind: "load_session_tools", sessionId: initial.activeSessionId }) });
      try {
        const deadline = Date.now() + 5000;
        while (!(await fs.stat(entered).catch(() => undefined))) {
          assert.ok(Date.now() < deadline, "MCP discovery reached its gate");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        await appendSessionEvent(directory, initial.activeSessionId, { kind: "tool_result", name: "builtin_suno_inspect_music_service",
          content: JSON.stringify({ query: "library", provenance: { connectionId: connection.id, accountId: "user_fixture" },
            clips: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Recorded during discovery" }] }),
        });
      } finally { await fs.writeFile(release, "release"); }
      const response = await loading;
      assert.equal(response.status, 200);
      const state = await response.json() as ChatDialogState;
      const panel = state.sessionToolCatalog!.groups.flatMap(group => group.tools)
        .find(tool => tool.name.endsWith("cover_music"))!.audioPanel!;
      assert.equal(panel.suggestions?.clips?.[0]?.label, "Recorded during discovery");
      assert.equal(await fs.readFile(entered, "utf8"), "list\n");
    } },
  } as never, interaction, { renderHtml: () => "<html></html>" });
});


test("the Session catalog includes host MIDI authoring and readers without an installed Plugin", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "live-smith-midi-catalog-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const session = await createSession(directory, { title: "Artifacts", projectKey: "project", scope: { kind: "selection", identity: "selection", label: "Artifacts" } });
  const state = { settings: { profiles: [] }, runtimeProfile: null } as unknown as ChatDialogState;
  const catalog = await loadSessionToolCatalog({ storageDirectory: directory, sessionId: session.id, state, signal: new AbortController().signal });
  const live = catalog.groups.find((group) => group.kind === "live")!.tools;
  for (const name of ["save_midi_artifact", "list_session_artifacts", "inspect_midi_artifact"]) {
    assert.equal(live.filter((tool) => tool.name === name).length, 1, `${name} must be discoverable exactly once`);
  }
  const noStorage = await loadSessionToolCatalog({ storageDirectory: undefined, sessionId: "session-one", state, signal: new AbortController().signal });
  assert.equal(noStorage.groups.flatMap((group) => group.tools).some((tool) => tool.name === "save_midi_artifact"), false);
});
