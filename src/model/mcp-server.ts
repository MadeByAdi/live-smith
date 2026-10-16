export interface McpServerConfig { enabled: boolean; port: number }
export interface McpServerSettings extends McpServerConfig { revision: string }

export function normalizeMcpServerConfig(value: unknown): McpServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP server settings require an enabled state and a port.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || typeof record.enabled !== "boolean" || !Number.isInteger(record.port) ||
    Number(record.port) < 1024 || Number(record.port) > 65535) throw new Error("Choose an MCP port between 1024 and 65535.");
  return { enabled: record.enabled, port: record.port as number };
}

export function normalizeMcpServerSettings(value: unknown): McpServerSettings {
  if (value === undefined) return { enabled: false, port: 17853, revision: "0" };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Saved MCP server settings are invalid.");
  const { revision, ...config } = value as Record<string, unknown>;
  if (typeof revision !== "string" || !/^(0|[1-9][0-9]*)$/u.test(revision) || revision.length > 128) throw new Error("Saved MCP server revision is invalid.");
  return { ...normalizeMcpServerConfig(config), revision };
}
