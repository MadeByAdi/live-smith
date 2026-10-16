import type { ExtensionContext } from "@ableton-extensions/sdk";
import { MAX_AUDIO_ASSET_BYTES } from "../../audio-services/contracts.js";
import { executeAgentTool, type AgentRecoveryState } from "../../agent/tool-execution.js";
import type { ToolOperationOutput } from "../../agent/tool-operation.js";
import type { UiMessage } from "../../i18n/ui-message.js";
import { interactionContextForScope } from "../../live/context.js";
import { observeLive, readArrangementAudio } from "../../live/observer.js";
import { createLiveSetGuard } from "../../live/set-identity.js";
import type { ModelToolCall } from "../../model/contracts.js";
import { saveSessionAttachment } from "../../storage/attachments.js";
import { assertMcpServerClientCurrent, type McpServerClient } from "../../storage/mcp-server-auth.js";
import { listSessions } from "../../storage/sessions.js";
import { actionDiffGroups } from "../../ui/action-diff.js";
import { addAudioAssetSampleSources } from "../audio/audio-asset-sources.js";
import { conversationContextForSession, projectKeyForContext } from "../context/session-context.js";
import { LiveMutationQueue } from "../live-mutation-queue.js";
import { providerFetchForStorage } from "../network.js";
import { attachmentMutationFence, globalSettingsMutationFence, requestConfigurationFence } from "../session/session-fences.js";
import { sessionMutationFenceKey } from "../session/session-mutation-fence.js";
import { createLiveMutationExecution } from "../tools/live-tool-execution.js";
import { decidePlanApproval } from "../tools/tool-approvals.js";
import type { ToolOperationContext } from "../tools/tool-operations.js";
import { createSessionToolRuntime } from "../tools/tool-runtime.js";
import { createToolScope } from "../tools/tool-scope.js";
import type { ManagedSampleSource } from "../../live/sample-source.js";

export async function requireMcpSession(storageDirectory: string, client: McpServerClient) {
  await assertMcpServerClientCurrent(storageDirectory, client);
  const session = (await listSessions(storageDirectory, client.projectKey)).find(entry => entry.id === client.sessionId && !entry.archivedAt);
  if (!session) throw new Error("The bound Session is unavailable. Choose an active Session in Live Smith.");
  return session;
}

export async function createMcpSessionRuntime(input: {
  context: ExtensionContext<"1.0.0">; storageDirectory: string; client: McpServerClient;
  signal: AbortSignal; liveMutationQueue: LiveMutationQueue;
  onProgress(message: UiMessage): void;
}) {
  const { context, storageDirectory, client, signal } = input;
  const session = await requireMcpSession(storageDirectory, client);
  const guardSet = createLiveSetGuard(context);
  const assertLiveSetCurrent = () => {
    guardSet();
    if (projectKeyForContext(context) !== client.projectKey) throw new Error("This client is bound to another Live Set. Create an authorization for the current Set in Live Smith.");
  };
  const interaction = conversationContextForSession(session, client.projectKey === projectKeyForContext(context) ? interactionContextForScope(context, session.scope) : undefined);
  const scope = createToolScope({ storageDirectory, projectKey: client.projectKey, session, signal });
  const sources = new Map<string, ManagedSampleSource>();
  const runtime = await createSessionToolRuntime({ actor: { kind: "mcp", clientId: client.id, clientName: client.name }, projectKey: client.projectKey,
    creativeBrief: session.creativeBrief ?? "",
    plugins: { storageDirectory, sessionId: session.id, signal, fetchImpl: providerFetchForStorage(storageDirectory),
      ...(context.environment.tempDirectory ? { temporaryDirectory: context.environment.tempDirectory } : {}),
      withAuthorization: (authorizationSignal, operation) => requestConfigurationFence.run(sessionMutationFenceKey(storageDirectory, "request-configuration"), authorizationSignal, operation) },
    audio: { context, assertLiveSetCurrent, storageDirectory, sessionId: session.id, requestId: "external", attachmentRefs: [],
      target: interaction.target, signal, onProgress: input.onProgress,
      onAssets: assets => addAudioAssetSampleSources({ context, storageDirectory, sessionId: session.id, signal }, sources, assets),
      modelAudioInput: { canAccept: byteLength => byteLength <= MAX_AUDIO_ASSET_BYTES },
      withGenerationAuthorization: (authorizationSignal, operation) => globalSettingsMutationFence.run(sessionMutationFenceKey(storageDirectory, "global-settings"), authorizationSignal, operation) },
  });
  scope.subscribe();
  return {
    tools: () => runtime.tools(true),
    async execute(call: ModelToolCall, operation: ToolOperationContext, recovery: AgentRecoveryState): Promise<ToolOperationOutput> {
      await requireMcpSession(storageDirectory, client);
      const result = await executeAgentTool({ signal,
        admittedToolNames: runtime.tools(true).map(tool => tool.function.name),
        externalTools: { names: runtime.externalTools.tools().map(tool => tool.function.name), execute: call => runtime.externalTools.callTool(call) },
        observe: async request => {
          assertLiveSetCurrent();
          if (request.type !== "read_arrangement_audio") return observeLive(context, request, interaction.target, signal);
          const rendered = await readArrangementAudio(context, request, interaction.target, signal, undefined, assertLiveSetCurrent);
          assertLiveSetCurrent();
          return { content: rendered.summary, modelInputPart: { type: "audio", fileName: rendered.fileName, mediaType: rendered.inspection.mediaType, bytes: rendered.bytes } };
        },
        ...createLiveMutationExecution({ context, interaction, storageDirectory, sessionId: session.id, signal, assertLiveSetCurrent,
          ...scope, requestAudioSources: sources, onProgress: operation.onProgress }),
        confirmActions: (plan, preflight, operationId) => decidePlanApproval(storageDirectory, session.id, plan, () => operation.requestApproval({
          kind: "apply", operationId, message: plan.message, plan, groups: actionDiffGroups(plan.actions, plan.targets),
          ...(preflight.previews ? { previews: preflight.previews } : {}),
        })),
        confirmRecoveryResolution: message => operation.requestApproval({ kind: "resolve_recovery", message, groups: [] }),
        withActionExecutionLock: execute => input.liveMutationQueue.run(signal, async () => { await requireMcpSession(storageDirectory, client); assertLiveSetCurrent(); return execute(); }),
        onProgress: operation.onProgress, onEvent: operation.onEvent,
      }, call, recovery);
      let audioAttachmentId: string | undefined;
      if (result.modelInputPart) {
        const part = result.modelInputPart;
        const stored = await attachmentMutationFence.run(sessionMutationFenceKey(storageDirectory, session.id), signal, () => saveSessionAttachment(storageDirectory,
          session.id, { fileName: part.fileName, bytes: part.bytes, claimedMediaType: part.mediaType, signal },
          // Operation outputs are consumed by their receipt; pending user uploads keep their own quota.
          { preSavePendingAttachmentRefs: [] }));
        audioAttachmentId = stored.id;
      }
      return { content: result.toolContent, failed: result.failed,
        ...(call.name === "apply_live_actions" && result.cancelled ? { cancelled: true } : {}),
        ...(result.outcomeUnknown ? { outcomeUnknown: true } : {}),
        ...(result.artifacts ? { artifacts: result.artifacts } : {}), ...(audioAttachmentId ? { audioAttachmentId } : {}) };
    },
    async close() { scope.close(); await runtime.close(); },
  };
}
