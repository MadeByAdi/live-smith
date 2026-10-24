import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionContext } from "@ableton-extensions/sdk";
import { createAgentRecoveryState, type AgentRecoveryState } from "../../agent/tool-execution.js";
import { resolveEditScopes } from "../../agent/edit-scopes.js";
import { normalizeMcpServerSettings, type McpServerSettings } from "../../model/mcp-server.js";
import type { ModelFunctionTool } from "../../model/provider.js";
import { createHostAbortController } from "../../runtime/host.js";
import { registerLocalMcpEndpoint } from "../../runtime/local-mcp-endpoint.js";
import { listSessionAttachments, sessionAttachmentRefFromStored } from "../../storage/attachments.js";
import { loadSessionEvents } from "../../storage/events.js";
import { authenticateMcpServerClient, createMcpServerClient, listMcpServerClients, revokeMcpServerClient, rotateMcpServerClient } from "../../storage/mcp-server-auth.js";
import { createSession, listSessions } from "../../storage/sessions.js";
import { loadAgentSettings } from "../../storage/settings.js";
import { activeRecoveryLedgerFromEvents, projectKeyForContext } from "../context/session-context.js";
import type { LiveMutationQueue } from "../live-mutation-queue.js";
import { sessionMutationFence, requestConfigurationFence } from "../session/session-fences.js";
import { sessionMutationFenceKey } from "../session/session-mutation-fence.js";
import { invalidateGlobalState, subscribeGlobalStateInvalidations, subscribeSessionStateInvalidations } from "../session/session-state-events.js";
import { ToolOperations } from "../tools/tool-operations.js";
import { handleMcpFileRequest, listMcpResources, mcpUploadDescription, readMcpResource } from "./resources.js";
import { createMcpHttpServer } from "./server.js";
import { createMcpSessionRuntime, requireMcpSession } from "./tool-runtime.js";
import { jsonMcpResult, mcpHelperTools, mcpOperationResult, mcpOperationSnapshot } from "./tool-results.js";

export type McpService = ReturnType<typeof createMcpService>;
export function createMcpService(input: { context: ExtensionContext<"1.0.0">; storageDirectory: string; liveMutationQueue: LiveMutationQueue;
  openSession(sessionId: string): Promise<void> }) {
  const { context, storageDirectory } = input;
  const source = Symbol("mcp-service");
  let server: Awaited<ReturnType<typeof createMcpHttpServer>> | undefined;
  let controller = createHostAbortController();
  let operations = new ToolOperations(storageDirectory, input.openSession);
  let settings: McpServerSettings = normalizeMcpServerSettings(undefined);
  let error: string | undefined;
  let closed = false;
  let revision: string | undefined;
  let refreshTail: Promise<void> = Promise.resolve();
  let unregisterEndpoint: (() => void) | undefined;
  const catalog = new Map<string, { clientId: string; sessionId: string; tools: Promise<readonly ModelFunctionTool[]> }>();
  const recoveries = new Map<string, { revision: string | undefined; state: AgentRecoveryState }>();
  const baseUrl = () => `http://127.0.0.1:${settings.port}`;
  const notify = () => invalidateGlobalState(storageDirectory, { source });
  const clearCatalog = (sessionId?: string) => {
    let invalidated = false;
    for (const [key, entry] of catalog) {
      if (sessionId === undefined || entry.sessionId === sessionId) {
        catalog.delete(key);
        invalidated = true;
      }
    }
    if (sessionId === undefined || invalidated) server?.notifyToolsChanged();
  };
  const forgetClientCatalog = (clientId: string) => {
    for (const [key, entry] of catalog) if (entry.clientId === clientId) catalog.delete(key);
  };
  const refresh = () => {
    refreshTail = refreshTail.catch(() => {}).then(async () => {
      if (closed) return;
      const next = normalizeMcpServerSettings((await loadAgentSettings(storageDirectory)).mcpServer);
      if (revision === next.revision) return;
      revision = next.revision; settings = next; error = undefined;
      controller.abort(); await server?.close(); server = undefined;
      await operations.close(); unregisterEndpoint?.(); unregisterEndpoint = undefined;
      controller = createHostAbortController(); operations = new ToolOperations(storageDirectory, input.openSession); clearCatalog();
      if (settings.enabled) {
        try {
          unregisterEndpoint = registerLocalMcpEndpoint(`${baseUrl()}/mcp`);
          server = await createMcpHttpServer({ port: settings.port,
            controlTools: mcpHelperTools,
            authenticate: token => authenticateMcpServerClient(storageDirectory, token),
            tools: async client => {
              await requireMcpSession(storageDirectory, client);
              const key = JSON.stringify([client.id, client.generation]);
              let pending = catalog.get(key)?.tools;
              if (!pending) {
                pending = (async () => {
                  const runtime = await createMcpSessionRuntime({ ...input, client, signal: controller.signal, onProgress() {} });
                  try { return [...runtime.tools(), ...mcpHelperTools]; } finally { await runtime.close(); }
                })();
                catalog.set(key, { clientId: client.id, sessionId: client.sessionId, tools: pending });
                void pending.catch(() => { if (catalog.get(key)?.tools === pending) catalog.delete(key); });
              }
              return pending;
            },
            callTool: async (client, name, args) => {
              const session = await requireMcpSession(storageDirectory, client);
              if (name === "livesmith_get_context") return jsonMcpResult({ projectKey: client.projectKey, currentSet: projectKeyForContext(context) === client.projectKey,
                session: { id: session.id, title: session.title, scope: session.scope, editScopes: resolveEditScopes(session.editScopes), approvalMode: session.approvalMode ?? "manual" },
                client: { id: client.id, name: client.name }, upload: { ...mcpUploadDescription, url: `${baseUrl()}/attachments` },
                attachments: (await listSessionAttachments(storageDirectory, session.id)).map(sessionAttachmentRefFromStored),
                recovery: activeRecoveryLedgerFromEvents(await loadSessionEvents(storageDirectory, session.id)) ?? null });
              if (name === "livesmith_get_operation") return args.operationId === undefined
                ? jsonMcpResult((await operations.list(session.id)).map(mcpOperationSnapshot)) : mcpOperationResult(await operations.read(session.id, String(args.operationId)), session.id);
              if (name === "livesmith_cancel_operation") return jsonMcpResult(mcpOperationSnapshot(await operations.cancel(session.id, String(args.operationId))));
              const operation = await operations.start(session.id, { kind: "mcp", clientId: client.id, clientName: client.name }, name,
                operation => sessionMutationFence.runNamed(sessionMutationFenceKey(storageDirectory, session.id), "send", operation.signal, async () => {
                  const before = await loadSessionEvents(storageDirectory, session.id);
                  const recoveryRevision = before.findLast(event => event.applyOperation || event.recovery)?.id;
                  let recovery = recoveries.get(session.id);
                  if (!recovery || recovery.revision !== recoveryRevision) {
                    recovery = { revision: recoveryRevision, state: createAgentRecoveryState(activeRecoveryLedgerFromEvents(before)) }; recoveries.set(session.id, recovery);
                  }
                  const runtime = await createMcpSessionRuntime({ ...input, client, signal: operation.signal, onProgress: operation.onProgress });
                  try { return await runtime.execute({ id: operation.operationId, name, arguments: JSON.stringify(args) }, operation, recovery.state); }
                  finally {
                    await runtime.close();
                    recovery.revision = (await loadSessionEvents(storageDirectory, session.id)).findLast(event => event.applyOperation || event.recovery)?.id;
                  }
                }));
              await Promise.race([operations.wait(operation.id), delay(150)]);
              return mcpOperationResult(await operations.read(session.id, operation.id), session.id);
            },
            listResources: (client, signal) => listMcpResources(storageDirectory, client, signal),
            readResource: (client, uri, signal) => readMcpResource(storageDirectory, client, uri, baseUrl(), signal),
            handleFileRequest: (client, request, response, signal) => handleMcpFileRequest(storageDirectory, client, request, response, signal),
          });
        } catch (cause) {
          unregisterEndpoint?.(); unregisterEndpoint = undefined;
          error = cause instanceof Error ? cause.message : "MCP service could not start.";
        }
      }
      notify();
    });
    return refreshTail;
  };
  const unsubscribeGlobal = subscribeGlobalStateInvalidations(storageDirectory, change => {
    if (change.source === source) return;
    if (change.target === "tools" || change.target === "all") clearCatalog();
    if (change.target !== "tools") void refresh().catch(() => {});
  });
  const unsubscribeSession = subscribeSessionStateInvalidations(storageDirectory, change => {
    if (change.target === "tools" || change.target === "all") clearCatalog(change.sessionId);
  });
  return {
    start: refresh, refresh,
    async state() { return { settings, status: server ? "running" as const : error ? "error" as const : "disabled" as const,
      url: `${baseUrl()}/mcp`, ...(error ? { error } : {}), clients: await listMcpServerClients(storageDirectory) }; },
    async createClient(name: string, sessionId?: string) {
      return requestConfigurationFence.run(sessionMutationFenceKey(storageDirectory, "request-configuration"), async () => {
        const projectKey = projectKeyForContext(context);
        const session = sessionId ? (await listSessions(storageDirectory, projectKey)).find(entry => entry.id === sessionId && !entry.archivedAt)
          : await createSession(storageDirectory, { projectKey, title: name, scope: { kind: "selection", identity: `external-${randomUUID()}`, label: "Live Set" }, approvalMode: "manual" });
        if (!session) throw new Error("Choose an active Session in the current Live Set.");
        const result = await createMcpServerClient(storageDirectory, { name, projectKey, sessionId: session.id });
        notify(); return { ...result, url: `${baseUrl()}/mcp` };
      });
    },
    async rotateClient(clientId: string, generation: string) {
      const result = await rotateMcpServerClient(storageDirectory, clientId, generation);
      await operations.cancelActor(clientId); forgetClientCatalog(clientId); notify(); return { ...result, url: `${baseUrl()}/mcp` };
    },
    async revokeClient(clientId: string, generation: string) {
      await revokeMcpServerClient(storageDirectory, clientId, generation);
      await operations.cancelActor(clientId); forgetClientCatalog(clientId); notify();
    },
    approvals: (sessionId: string) => operations.approvals(sessionId),
    operations: (sessionId: string) => operations.list(sessionId),
    resolveApproval: (sessionId: string, operationId: string, approve: boolean) => operations.resolveApproval(sessionId, operationId, approve),
    cancel: (sessionId: string, operationId: string) => operations.cancel(sessionId, operationId),
    async close() {
      closed = true; unsubscribeGlobal(); unsubscribeSession();
      await refreshTail.catch(() => {}); controller.abort(); await server?.close(); server = undefined;
      await operations.close(); unregisterEndpoint?.();
    },
  };
}
