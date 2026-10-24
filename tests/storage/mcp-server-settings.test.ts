import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAgentSettings, saveGlobalSettings } from "../../src/storage/settings.js";

test("MCP server configuration round-trips independently of model Profiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mcp-server-settings-"));
  try {
    const initial = await loadAgentSettings(directory);
    assert.equal(initial.mcpServer?.enabled ?? false, false);
    const saved = await saveGlobalSettings(directory, { mcpServer: { enabled: true, port: 17853 } });
    assert.deepEqual(saved.mcpServer, { enabled: true, port: 17853, revision: "1" });
    assert.equal((await loadAgentSettings(directory)).mcpServer?.enabled, true);
    assert.deepEqual(saved.profiles, []);
    await saveGlobalSettings(directory, { customInstructions: "Keep the bass" });
    assert.deepEqual((await loadAgentSettings(directory)).mcpServer, saved.mcpServer);
    await assert.rejects(saveGlobalSettings(directory, { mcpServer: { enabled: true, port: 0 } }));
    await assert.rejects(saveGlobalSettings(directory, { mcpServer: { enabled: true, port: 65536 } }));
    const stopped = await saveGlobalSettings(directory, { mcpServer: { enabled: false, port: 17853 } });
    assert.equal(stopped.mcpServer?.revision, "2");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
