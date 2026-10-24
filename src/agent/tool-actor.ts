
export type ToolActor =
  | { kind: "model"; profileId: string; model: string }
  | { kind: "mcp"; clientId: string; clientName: string };

export function isMcpToolActor(value: unknown): value is Extract<ToolActor, { kind: "mcp" }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actor = value as Record<string, unknown>;
  return Object.keys(actor).length === 3 && actor.kind === "mcp" && typeof actor.clientId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(actor.clientId) &&
    typeof actor.clientName === "string" && actor.clientName.trim().length > 0 && actor.clientName.length <= 120 &&
    !/[\u0000-\u001f\u007f]/u.test(actor.clientName);
}
