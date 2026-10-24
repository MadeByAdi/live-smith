import type { ChatDialogState } from "./chat-state.js";

/** Shared by host snapshots and browser reconciliation; local result suggestions have their own projection. */
export function sessionToolCatalogOwner(state: ChatDialogState): string {
  return JSON.stringify([
    state.activeSessionId,
    state.activeProfileRevision,
    state.runtimeProfile,
    state.integrationConnections?.revision ?? "0",
    state.settings.networkProxyRevision ?? "0",
    state.plugins.filter(plugin => plugin.enabled &&
      (plugin.mcpServers.length > 0 || plugin.issues.some(issue => issue !== "invalid_skill")))
      .map(plugin => [plugin.id, plugin.sha256, plugin.mcpServers, plugin.userConfig?.revision]),
    state.sunoAccounts ?? [],
    state.mcpOAuthStates ?? [],
    (state.audioJobs?.length ?? 0) > 0,
  ], (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : value);
}
