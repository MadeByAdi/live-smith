import type { ToolActor } from "../../agent/tool-actor.js";
import { liveSmithTools } from "../../agent/tool-definitions.js";
import { midiArtifactImportActionSchema } from "../../plugins/artifacts.js";
import { ToolRegistry } from "../../plugins/registry.js";
import { createRequestAudioTools } from "../audio/request-audio-tools.js";
import { creativeBriefProposalTool, proposeCreativeBrief } from "../context/creative-brief.js";
import { createMidiArtifactAuthoringToolset, midiArtifactAuthoringTool } from "../midi/midi-artifact-tools.js";
import { createParameterArtifactToolset, parameterArtifactTools } from "../parameters/parameter-artifact-tools.js";
import { createRequestPluginTools } from "../plugins/request-plugin-tools.js";
import { createSessionArtifactToolset, sessionArtifactTools } from "../session/session-artifact-tools.js";

export function sessionNativeTools(storageAvailable: boolean, readArrangementAudio: boolean) {
  return [...liveSmithTools({ readArrangementAudio,
    ...(storageAvailable ? { additionalActionSchemas: [midiArtifactImportActionSchema] } : {}) }),
    creativeBriefProposalTool,
    ...(storageAvailable ? [...sessionArtifactTools, midiArtifactAuthoringTool, ...parameterArtifactTools] : [])];
}

/** Owns the same host-executable toolsets for internal and external callers. */
export async function createSessionToolRuntime(input: {
  actor: ToolActor;
  projectKey: string;
  creativeBrief: string;
  plugins: Omit<Parameters<typeof createRequestPluginTools>[0], "onAudioArtifacts">;
  audio: Omit<Parameters<typeof createRequestAudioTools>[0], "hasPluginAudioOutputs">;
}) {
  let audio: Awaited<ReturnType<typeof createRequestAudioTools>>;
  const plugins = await createRequestPluginTools({ ...input.plugins, onAudioArtifacts: (artifacts) => audio.registerArtifacts(artifacts) });
  try {
    audio = await createRequestAudioTools({ ...input.audio, hasPluginAudioOutputs: plugins.hasAudioOutputs });
    const { context, storageDirectory, sessionId, signal, target, assertLiveSetCurrent, artifactSource } = input.audio;
    const native = new ToolRegistry([
      { id: "live-smith.creative-brief", tools: () => [creativeBriefProposalTool],
        callTool: async (call) => proposeCreativeBrief(call.arguments, input.creativeBrief) },
      ...(storageDirectory ? [createSessionArtifactToolset({ storageDirectory, sessionId, signal }),
        createMidiArtifactAuthoringToolset({ storageDirectory, sessionId, signal, actor: input.actor,
          ...(artifactSource?.kind === "midi" ? { revisionOf: artifactSource.id } : {}) }),
        createParameterArtifactToolset({ context, storageDirectory, sessionId, signal, target, assertLiveSetCurrent,
          actor: input.actor, projectKey: input.projectKey,
          ...(artifactSource?.kind === "device-parameters" ? { revisionOf: artifactSource.id } : {}) })] : []),
    ]);
    const externalTools = new ToolRegistry([native, ...audio.toolsets, ...plugins.toolsets]);
    return {
      plugins, externalTools,
      tools(readArrangementAudio: boolean) {
        return [...sessionNativeTools(Boolean(storageDirectory), readArrangementAudio),
          ...audio.toolsets.flatMap((toolset) => toolset.tools()), ...plugins.tools()];
      },
      close: () => externalTools.close(),
    };
  } catch (error) { await plugins.close(); throw error; }
}
