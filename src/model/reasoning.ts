import type {
  ModelReasoning,
  ModelReasoningStreamUpdate,
} from "./contracts.js";

export function requireModelReasoning(
  value: ModelReasoning | undefined,
): ModelReasoning | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "content") ||
    typeof value.content !== "string"
  ) {
    throw new TypeError("Model visible reasoning is invalid.");
  }
  return { content: value.content };
}

export function modelReasoningFromContent(
  content: string,
  stageObserved: boolean,
): ModelReasoning | undefined {
  if (!stageObserved) return undefined;
  return { content };
}

export function mergeModelReasoning(
  values: readonly (ModelReasoning | undefined)[],
): ModelReasoning | undefined {
  const present = values.filter(
    (value): value is ModelReasoning => value !== undefined,
  );
  if (!present.length) return undefined;
  return {
    content: present
      .map((value) => value.content)
      .filter((content) => content.length > 0)
      .join("\n\n"),
  };
}

export function createModelReasoningStreamReporter(
  callback: ((update: ModelReasoningStreamUpdate) => Promise<void> | void) |
    undefined,
): (update: ModelReasoningStreamUpdate) => Promise<void> {
  let started = false;
  return async (update) => {
    if (update.type === "start") {
      if (started) return;
      started = true;
      await callback?.(update);
      return;
    }
    if (!started) {
      started = true;
      await callback?.({ type: "start" });
    }
    if (update.type === "replace" || update.delta) await callback?.(update);
  };
}
