/**
 * Disposable R&D command: it controls the already-installed upstream
 * AgentAudioTap through its file protocol, then uses Smith's ordinary opaque
 * Session artifact → approved local MCP route.  It never controls Live's
 * transport; begin playback manually after launching this command.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { admitFinalizedAgentAudioTapCapture, createAgentAudioTapCaptureIntent, writeAgentAudioTapCommand } from "../src/app/agent-audio-tap.js";
import { createRequestPluginTools } from "../src/app/request-plugin-tools.js";
import { createHostAbortController } from "../src/runtime/host.js";
import { installPlugin, listInstalledPlugins, setPluginArtifactPermissionApproved, setPluginEnabled, setPluginMcpServerApproved } from "../src/storage/plugins.js";
import { createSession } from "../src/storage/sessions.js";

const root = process.cwd();
const storage = path.join(root, ".agent-audio-tap-proof-storage");
const pluginZip = path.resolve(root, "../live-smith-audio-analyzer-rs/artifacts/local.audio-analyzer-rs-1.0.0-final-evidence.zip");
const commandFile = path.join(os.homedir(), ".ableton-live-mcp", "agent_audio_tap_command.json");
const signal = createHostAbortController().signal;
const intent = createAgentAudioTapCaptureIntent();
const capturePath = path.join(os.tmpdir(), `live-smith-agent-audio-tap-${intent.captureId}.wav`);

await fs.mkdir(storage, { recursive: true, mode: 0o700 });
const session = await createSession(storage, {
  title: "AgentAudioTap Main proof", projectKey: "agent-audio-tap-rnd",
  scope: { kind: "track", identity: "main", label: "Main" },
});
const plugin = (await listInstalledPlugins(storage)).find((entry) => entry.id === "local.audio-analyzer-rs") ??
  await installPlugin(storage, new Uint8Array(await fs.readFile(pluginZip)));
await setPluginMcpServerApproved(storage, plugin.id, "audio_analyzer", true);
await setPluginArtifactPermissionApproved(storage, plugin.id, "audio_analyzer", "input", true);
await setPluginEnabled(storage, plugin.id, true);

// The only control action: start with an opaque host-owned destination. Live
// remains under the user's manual transport control.
await writeAgentAudioTapCommand(commandFile, { id: `${intent.captureId}_start`, command: "start", path: capturePath });
// Deliberately generous for manual playback; this script never starts or stops
// Live transport. The final artifact records its measured duration.
await new Promise((resolve) => setTimeout(resolve, 12_000));
await writeAgentAudioTapCommand(commandFile, { id: `${intent.captureId}_stop`, command: "stop" });

// A stopped sfrecord~ must produce a stable regular WAV before Smith reads it.
let previous = -1;
for (let attempt = 0; attempt < 20; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  const size = (await fs.stat(capturePath)).size;
  if (size > 44 && size === previous) break;
  previous = size;
  if (attempt === 19) throw new Error("AgentAudioTap WAV did not stabilize after stop.");
}
const admitted = await admitFinalizedAgentAudioTapCapture({
  storageDirectory: storage, sessionId: session.id, intent, completedPath: capturePath, signal,
});
const tools = await createRequestPluginTools({
  storageDirectory: storage, temporaryDirectory: storage, sessionId: session.id, signal,
  withAuthorization: async (_signal, operation) => operation(),
});
try {
  const tool = tools.tools().find((entry) => entry.function.name.includes("audio_info"));
  if (!tool) throw new Error("The approved audio-analyzer info tool was not discovered.");
  const result = await tools.callTool({ id: intent.captureId, name: tool.function.name,
    arguments: JSON.stringify({ path: admitted.artifactRef }) });
  if (result.failed) throw new Error("The approved audio-analyzer tool failed.");
  console.log(JSON.stringify({
    captureId: admitted.captureId, artifactRef: admitted.artifactRef,
    channels: admitted.channels, durationSeconds: admitted.durationSeconds,
    analyzerSucceeded: true,
  }));
} finally {
  await tools.close();
}
