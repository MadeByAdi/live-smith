import type { ModelToolCall } from "../model/contracts.js";
import { validateAgentPlan,type AgentObservationRequest,type AgentPlan } from "./actions.js";

export function observationRequestFromToolCall(
  toolCall: ModelToolCall,
): AgentObservationRequest {
  const args = parseToolArguments(toolCall.arguments);
  switch (toolCall.name) {
    case "inspect_live_set":
      assertOnlyKeys(args, [], `${toolCall.name} arguments`);
      return { type: "inspect_live_set" };
    case "inspect_current_object":
      assertOnlyKeys(
        args,
        [...observationItemPageKeys, ...observationParameterPageKeys],
        `${toolCall.name} arguments`,
      );
      return {
        type: "inspect_current_object",
        ...observationItemPageProps(args),
        ...observationParameterPageProps(args),
      };
    case "inspect_track":
      assertOnlyKeys(
        args,
        [
          ...observationTrackSelectorKeys,
          ...observationItemPageKeys,
          ...observationParameterPageKeys,
        ],
        `${toolCall.name} arguments`,
      );
      return {
        type: "inspect_track",
        ...observationTrackSelectorProps(args),
        ...observationItemPageProps(args),
        ...observationParameterPageProps(args),
      };
    case "inspect_take_lane": {
      assertOnlyKeys(
        args,
        ["trackName", "laneIndex", "laneName", ...observationItemPageKeys],
        `${toolCall.name} arguments`,
      );
      const laneIndex = optionalIntegerProp(args.laneIndex, "laneIndex", 0);
      if (laneIndex.laneIndex === undefined) {
        throw new Error("inspect_take_lane requires laneIndex.");
      }
      return {
        type: "inspect_take_lane",
        ...optionalStringProp(args.trackName, "trackName"),
        laneIndex: laneIndex.laneIndex,
        ...optionalStringProp(args.laneName, "laneName"),
        ...observationItemPageProps(args),
      };
    }
    case "inspect_device":
      assertOnlyKeys(
        args,
        [
          ...observationTrackSelectorKeys,
          "deviceName",
          "deviceIndex",
          ...observationParameterPageKeys,
        ],
        `${toolCall.name} arguments`,
      );
      return {
        type: "inspect_device",
        ...observationTrackSelectorProps(args),
        deviceName: requiredString(args.deviceName, "deviceName"),
        ...optionalIntegerProp(args.deviceIndex, "deviceIndex", 0),
        ...observationParameterPageProps(args),
      };
    case "inspect_device_tree":
      assertOnlyKeys(
        args,
        [
          ...observationTrackSelectorKeys,
          "deviceName",
          "devicePath",
          ...observationItemPageKeys,
          ...observationParameterPageKeys,
        ],
        `${toolCall.name} arguments`,
      );
      return {
        type: "inspect_device_tree",
        ...observationTrackSelectorProps(args),
        ...optionalStringProp(args.deviceName, "deviceName"),
        ...optionalDevicePathProp(args.devicePath),
        ...observationItemPageProps(args),
        ...observationParameterPageProps(args),
      };
    case "inspect_rack_chain": {
      assertOnlyKeys(
        args,
        [
          ...observationTrackSelectorKeys,
          "rackName",
          "rackPath",
          "chainIndex",
          ...observationItemPageKeys,
        ],
        `${toolCall.name} arguments`,
      );
      const chainIndex = optionalIntegerProp(
        args.chainIndex,
        "chainIndex",
        0,
        4095,
      );
      if (chainIndex.chainIndex === undefined) {
        throw new Error("inspect_rack_chain requires chainIndex.");
      }
      return {
        type: "inspect_rack_chain",
        ...observationTrackSelectorProps(args),
        rackName: requiredString(args.rackName, "rackName"),
        ...optionalRackPathProp(args.rackPath),
        chainIndex: chainIndex.chainIndex,
        ...observationItemPageProps(args),
      };
    }
    case "inspect_mixer":
      assertOnlyKeys(args, observationTrackSelectorKeys, `${toolCall.name} arguments`);
      return {
        type: "inspect_mixer",
        ...observationTrackSelectorProps(args),
      };
    case "inspect_clip": {
      assertOnlyKeys(
        args,
        ["trackName", "clipName", "startBeat", "slotIndex", ...observationItemPageKeys],
        `${toolCall.name} arguments`,
      );
      const request = {
        type: "inspect_clip" as const,
        ...optionalStringProp(args.trackName, "trackName"),
        ...optionalStringProp(args.clipName, "clipName"),
        ...optionalNumberProp(args.startBeat, "startBeat"),
        ...optionalIntegerProp(args.slotIndex, "slotIndex", 0),
        ...observationItemPageProps(args),
      } as Extract<AgentObservationRequest, { type: "inspect_clip" }>;
      if (request.startBeat !== undefined && request.slotIndex !== undefined) {
        throw new Error("inspect_clip uses either startBeat or slotIndex, not both.");
      }
      return request;
    }
    case "inspect_midi_clip":
      assertOnlyKeys(
        args,
        ["trackName", "clipName", "startBeat", "slotIndex", "noteOffset", "noteLimit"],
        `${toolCall.name} arguments`,
      );
      {
        const request = {
          type: "inspect_midi_clip",
          ...optionalStringProp(args.trackName, "trackName"),
          ...optionalStringProp(args.clipName, "clipName"),
          ...optionalNumberProp(args.startBeat, "startBeat"),
          ...optionalIntegerProp(args.slotIndex, "slotIndex", 0),
          ...optionalIntegerProp(args.noteOffset, "noteOffset", 0),
          ...optionalIntegerProp(args.noteLimit, "noteLimit", 1, 256),
        } as Extract<AgentObservationRequest, { type: "inspect_midi_clip" }>;
        if (request.startBeat !== undefined && request.slotIndex !== undefined) {
          throw new Error("inspect_midi_clip uses either startBeat or slotIndex, not both.");
        }
        return request;
      }
    case "inspect_midi_evidence": {
      assertOnlyKeys(args, ["trackName", "clipName", "startBeat", "slotIndex"], `${toolCall.name} arguments`);
      const request = {
        type: "inspect_midi_evidence" as const,
        ...optionalStringProp(args.trackName, "trackName"),
        ...optionalStringProp(args.clipName, "clipName"),
        ...optionalNumberProp(args.startBeat, "startBeat"),
        ...optionalIntegerProp(args.slotIndex, "slotIndex", 0),
      } as Extract<AgentObservationRequest, { type: "inspect_midi_evidence" }>;
      if (request.startBeat !== undefined && request.slotIndex !== undefined) {
        throw new Error("inspect_midi_evidence uses either startBeat or slotIndex, not both.");
      }
      return request;
    }
    case "inspect_guitar_playability": {
      assertOnlyKeys(args, ["trackName", "clipName", "startBeat", "slotIndex", "maxFret", "maxFretSpan"], `${toolCall.name} arguments`);
      const request = { type: "inspect_guitar_playability" as const, ...optionalStringProp(args.trackName, "trackName"), ...optionalStringProp(args.clipName, "clipName"), ...optionalNumberProp(args.startBeat, "startBeat"), ...optionalIntegerProp(args.slotIndex, "slotIndex", 0), ...optionalIntegerProp(args.maxFret, "maxFret", 0, 127), ...optionalIntegerProp(args.maxFretSpan, "maxFretSpan", 0, 127) } as Extract<AgentObservationRequest, { type: "inspect_guitar_playability" }>;
      if (request.startBeat !== undefined && request.slotIndex !== undefined) throw new Error("inspect_guitar_playability uses either startBeat or slotIndex, not both.");
      return request;
    }
    case "analyze_audio_clip":
      assertOnlyKeys(
        args,
        ["trackName", "clipName", "startBeat"],
        `${toolCall.name} arguments`,
      );
      return {
        type: "analyze_audio_clip",
        ...optionalStringProp(args.trackName, "trackName"),
        ...optionalStringProp(args.clipName, "clipName"),
        ...optionalNumberProp(args.startBeat, "startBeat"),
      };
    case "read_arrangement_audio": {
      assertOnlyKeys(
        args,
        ["trackName", "clipName", "clipStartBeat", "startBeat", "endBeat"],
        `${toolCall.name} arguments`,
      );
      const request: Extract<AgentObservationRequest, {
        type: "read_arrangement_audio";
      }> = {
        type: "read_arrangement_audio" as const,
        ...optionalStringProp(args.trackName, "trackName"),
        ...optionalStringProp(args.clipName, "clipName"),
        ...optionalNumberProp(args.clipStartBeat, "clipStartBeat"),
        startBeat: requiredNumber(args.startBeat, "startBeat"),
        endBeat: requiredNumber(args.endBeat, "endBeat"),
      };
      if (request.endBeat <= request.startBeat) {
        throw new Error(
          "read_arrangement_audio requires endBeat greater than startBeat.",
        );
      }
      return request;
    }
    case "stage_arrangement_audio_artifact": {
      assertOnlyKeys(
        args,
        ["trackName", "clipName", "clipStartBeat", "startBeat", "endBeat"],
        `${toolCall.name} arguments`,
      );
      const request: Extract<AgentObservationRequest, {
        type: "stage_arrangement_audio_artifact";
      }> = {
        type: "stage_arrangement_audio_artifact" as const,
        ...optionalStringProp(args.trackName, "trackName"),
        ...optionalStringProp(args.clipName, "clipName"),
        ...optionalNumberProp(args.clipStartBeat, "clipStartBeat"),
        startBeat: requiredNumber(args.startBeat, "startBeat"),
        endBeat: requiredNumber(args.endBeat, "endBeat"),
      };
      if (request.endBeat <= request.startBeat) {
        throw new Error(
          "stage_arrangement_audio_artifact requires endBeat greater than startBeat.",
        );
      }
      return request;
    }
    case "capture_agent_audio_tap": {
      assertOnlyKeys(args, ["listenerName", "tapId"], `${toolCall.name} arguments`);
      const request = {
        type: "capture_agent_audio_tap" as const,
        ...optionalStringProp(args.listenerName, "listenerName"),
        ...optionalStringProp(args.tapId, "tapId"),
      } as Extract<AgentObservationRequest, { type: "capture_agent_audio_tap" }>;
      if (request.listenerName === undefined && request.tapId === undefined) {
        throw new Error("capture_agent_audio_tap requires listenerName or tapId.");
      }
      return request;
    }
    case "inspect_song_info":
      assertOnlyKeys(args, observationItemPageKeys, `${toolCall.name} arguments`);
      return { type: "inspect_song_info", ...observationItemPageProps(args) };
    default:
      throw new Error(`Unsupported observation tool: ${toolCall.name}`);
  }
}

const observationItemPageKeys = ["itemOffset", "itemLimit"] as const;
const observationTrackSelectorKeys = ["trackName", "trackRole", "trackIndex"] as const;
const observationParameterPageKeys = [
  "parameterOffset",
  "parameterLimit",
  "valueItemOffset",
  "valueItemLimit",
] as const;

function observationItemPageProps(args: Record<string, unknown>): {
  itemOffset?: number;
  itemLimit?: number;
} {
  return {
    ...optionalIntegerProp(args.itemOffset, "itemOffset", 0),
    ...optionalIntegerProp(args.itemLimit, "itemLimit", 1, 100),
  };
}

function observationTrackSelectorProps(args: Record<string, unknown>): {
  trackName?: string;
  trackRole?: "return" | "main";
  trackIndex?: number;
} {
  const trackName = optionalStringProp(args.trackName, "trackName");
  if (args.trackRole === undefined) {
    if (args.trackIndex !== undefined) {
      throw new Error("trackIndex requires trackRole return.");
    }
    return trackName;
  }
  if (args.trackRole !== "return" && args.trackRole !== "main") {
    throw new Error("trackRole must be return or main.");
  }
  if (args.trackRole === "main") {
    if (args.trackIndex !== undefined) {
      throw new Error("trackRole main does not use trackIndex.");
    }
    return { ...trackName, trackRole: "main" };
  }
  const trackIndex = optionalIntegerProp(args.trackIndex, "trackIndex", 0);
  if (trackIndex.trackIndex === undefined) {
    throw new Error("trackRole return requires trackIndex.");
  }
  return { ...trackName, trackRole: "return", trackIndex: trackIndex.trackIndex };
}

function observationParameterPageProps(args: Record<string, unknown>): {
  parameterOffset?: number;
  parameterLimit?: number;
  valueItemOffset?: number;
  valueItemLimit?: number;
} {
  return {
    ...optionalIntegerProp(args.parameterOffset, "parameterOffset", 0),
    ...optionalIntegerProp(args.parameterLimit, "parameterLimit", 1, 100),
    ...optionalIntegerProp(args.valueItemOffset, "valueItemOffset", 0),
    ...optionalIntegerProp(args.valueItemLimit, "valueItemLimit", 1, 100),
  };
}

export function actionPlanFromToolCall(toolCall: ModelToolCall): AgentPlan {
  return validateAgentPlan(parseToolArguments(toolCall.arguments));
}

export function parseToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // handled below
  }

  throw new Error("Invalid JSON arguments for tool call.");
}

export function isObservationTool(name: string): boolean {
  return (
    name === "inspect_live_set" ||
    name === "inspect_current_object" ||
    name === "inspect_track" ||
    name === "inspect_take_lane" ||
    name === "inspect_device" ||
    name === "inspect_device_tree" ||
    name === "inspect_rack_chain" ||
    name === "inspect_mixer" ||
    name === "inspect_clip" ||
    name === "inspect_midi_clip" ||
    name === "inspect_midi_evidence" ||
    name === "inspect_guitar_playability" ||
    name === "analyze_audio_clip" ||
    name === "read_arrangement_audio" ||
    name === "stage_arrangement_audio_artifact" ||
    name === "capture_agent_audio_tap" ||
    name === "inspect_song_info"
  );
}

function optionalDevicePathProp(
  value: unknown,
): { devicePath?: import("../live/device-tree.js").DevicePath } {
  const path = optionalPath(value, "devicePath");
  return path ? { devicePath: path } : {};
}

function optionalRackPathProp(
  value: unknown,
): { rackPath?: import("../live/device-tree.js").DevicePath } {
  const path = optionalPath(value, "rackPath");
  return path ? { rackPath: path } : {};
}

function optionalPath(
  value: unknown,
  key: "devicePath" | "rackPath",
): import("../live/device-tree.js").DevicePath | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${key} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  assertOnlyKeys(record, ["deviceIndex", "nested"], key);
  const deviceIndex = requiredNonNegativeInteger(record.deviceIndex, `${key}.deviceIndex`);
  if (record.nested !== undefined && !Array.isArray(record.nested)) {
    throw new Error(`${key}.nested must be an array.`);
  }
  const nested = (record.nested ?? []).map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`${key}.nested[${index}] must be an object.`);
    }
    const segment = item as Record<string, unknown>;
    assertOnlyKeys(segment, ["chainIndex", "deviceIndex"], `${key}.nested[${index}]`);
    return {
      chainIndex: requiredNonNegativeInteger(
        segment.chainIndex,
        `${key}.nested[${index}].chainIndex`,
      ),
      deviceIndex: requiredNonNegativeInteger(
        segment.deviceIndex,
        `${key}.nested[${index}].deviceIndex`,
      ),
    };
  });
  return {
    deviceIndex,
    ...(nested.length ? { nested } : {}),
  };
}

function requiredNonNegativeInteger(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${key} must be a non-negative integer.`);
  }
  return value;
}

export function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unknown) throw new Error(`${label} does not support property ${unknown}.`);
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Tool call requires string ${key}.`);
  }
  return value.trim();
}

function requiredNumber(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Tool call requires finite number ${key}.`);
  }
  return value;
}

function optionalStringProp(value: unknown, key: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Tool call ${key} must be a non-empty string when provided.`);
  }
  return { [key]: value.trim() };
}

function optionalNumberProp(value: unknown, key: string): Record<string, number> {
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Tool call ${key} must be a finite number when provided.`);
  }
  return { [key]: value };
}

function optionalIntegerProp(
  value: unknown,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): Record<string, number> {
  if (value === undefined) return {};
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `Tool call ${key} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return { [key]: value };
}
