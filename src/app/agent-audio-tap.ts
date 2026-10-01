import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { MAX_AUDIO_ASSET_BYTES } from "../audio-services/contracts.js";
import { copyAudioFileSafely } from "../live/audio-attachment-source.js";
import { throwIfAborted } from "../runtime/host.js";
import { createStorageId, isSafeStorageId, requireSafeStorageId } from "../storage/id.js";
import { saveAgentAudioTapArtifact } from "../storage/audio-assets.js";

export interface AgentAudioTapCaptureIntent {
  captureId: string;
  scope: "main" | "listener";
  tapPosition: "main_insertion_point" | "track_insertion_point";
  startBeat?: number;
  endBeat?: number;
  tapId?: string;
  trackName?: string;
  trackType?: "main" | "group" | "track" | "return";
  canonicalParent?: string;
  windowId?: string;
}

export interface AgentAudioTapListener {
  tapId: string;
  trackName: string;
  trackType: "main" | "group" | "track" | "return";
  canonicalParent: string;
  updatedAt: string;
}

export interface AgentAudioTapListenerReasoningView {
  tapId: string;
  trackName: string;
  trackType: AgentAudioTapListener["trackType"];
  canonicalParent: string;
  ambiguousName: boolean;
}

/** A bounded Arrangement interval, expressed in Live beats. */
export interface AgentAudioTapArrangementWindow {
  startBeat: number;
  endBeat: number;
}

type AgentAudioTapCommand = "start" | "stop" | "arm" | "begin" | "cancel";
type AgentAudioTapCaptureState = "armed" | "recording" | "stopped" | "failed";

interface AgentAudioTapCaptureReceipt {
  id: string;
  captureId: string;
  windowId: string;
  state: AgentAudioTapCaptureState;
  startBeat: number;
  endBeat: number;
}

/** The intentionally short manual-play capture window for the first Smith action. */
export const AGENT_AUDIO_TAP_CAPTURE_WINDOW_MS = 12_000;

export class AgentAudioTapCaptureError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentAudioTapCaptureError";
  }
}

export interface AgentAudioTapCaptureLifecycleResult {
  sessionId: string;
  requestedListener: "main" | "listener";
  requestedTapId: string | null;
  range: { startBeat: number; endBeat: number } | null;
  listenerResolved: boolean;
  armReached: boolean;
  beginReached: boolean;
  stopFinalizeReached: boolean;
  artifactAdmitted: boolean;
  outcome: "admitted" | "failed";
  failureStage?: "range_validation" | "listener_resolution" | "arm" | "begin" | "stop_finalize" | "artifact_admission";
  failureReason?: "invalid_range" | "listener_unavailable" | "acknowledgement_timeout" | "capture_failed" | "finalization_failed" | "cancelled" | "unconfirmed";
}

type AgentAudioTapCaptureLifecycleStage = "arm" | "arm_reached" | "begin" | "begin_reached" |
  "stop_finalize" | "stop_finalize_reached" | "artifact_admission" | "artifact_admitted";

function captureFailureReason(error: unknown, signal: AbortSignal): NonNullable<AgentAudioTapCaptureLifecycleResult["failureReason"]> {
  if (signal.aborted) return "cancelled";
  const message = error instanceof Error ? error.message : "";
  if (/valid bounded Arrangement selection/u.test(message)) return "invalid_range";
  if (/listener is not online|Main AgentAudioTap listener is not online/u.test(message)) return "listener_unavailable";
  if (/did not acknowledge/u.test(message)) return "acknowledgement_timeout";
  if (/could not prepare|could not be stopped/u.test(message)) return "capture_failed";
  if (/did not finalize|invalid or changed before admission|too short/u.test(message)) return "finalization_failed";
  return "unconfirmed";
}

function minimumCaptureDurationForWindow(window: AgentAudioTapArrangementWindow): number {
  const beatSpan = window.endBeat - window.startBeat;
  if (!Number.isFinite(beatSpan) || beatSpan <= 0) return 0.5;
  return Math.max(0.5, Math.min(8, beatSpan * 0.04));
}

export function createAgentAudioTapCaptureIntent(listener?: AgentAudioTapListener): AgentAudioTapCaptureIntent {
  if (listener) return { captureId: createStorageId("tapcapture"), scope: "listener", tapPosition: "track_insertion_point",
    tapId: listener.tapId, trackName: listener.trackName, trackType: listener.trackType,
    canonicalParent: listener.canonicalParent, windowId: createStorageId("tapwindow") };
  return { captureId: createStorageId("tapcapture"), scope: "main", tapPosition: "main_insertion_point" };
}

/** Write the upstream file command exactly once; no Remote Script, UDP, or MIDI route is used. */
export async function writeAgentAudioTapCommand(commandFile: string, value: {
  id: string; command: AgentAudioTapCommand; path?: string; targetTapId?: string; windowId?: string;
  captureId?: string; startBeat?: number; endBeat?: number;
}): Promise<void> {
  requireSafeStorageId(value.id, "AgentAudioTap command ID");
  if (value.targetTapId !== undefined) requireSafeStorageId(value.targetTapId, "AgentAudioTap target ID");
  if (value.windowId !== undefined) requireSafeStorageId(value.windowId, "AgentAudioTap window ID");
  if ((value.command === "start" || value.command === "arm") && (!value.path || !value.path.startsWith("/"))) {
    throw new Error("AgentAudioTap start requires an absolute host-owned output path.");
  }
  if (value.command === "arm" || value.command === "begin" || value.command === "cancel") {
    if (!value.captureId || !value.windowId || !Number.isFinite(value.startBeat) || !Number.isFinite(value.endBeat) ||
      value.startBeat! < 0 || value.endBeat! <= value.startBeat!) {
      throw new Error("AgentAudioTap bounded listen command requires a valid capture and Arrangement window.");
    }
    requireSafeStorageId(value.captureId, "AgentAudioTap capture ID");
  }
  await fs.writeFile(commandFile, JSON.stringify(value), { mode: 0o600 });
}

/** Reads only bounded, fresh status receipts produced by the disposable proof devices. */
export async function discoverAgentAudioTapListeners(input: {
  commandFile?: string; now?: number; maximumAgeMs?: number;
} = {}): Promise<AgentAudioTapListener[]> {
  const commandFile = input.commandFile ?? path.join(os.homedir(), ".ableton-live-mcp", "agent_audio_tap_command.json");
  const maximumAgeMs = input.maximumAgeMs ?? 5_000;
  const now = input.now ?? Date.now();
  const directory = path.dirname(commandFile);
  const prefix = `${path.basename(commandFile)}.tap_`;
  const suffix = ".status.json";
  const maximumLiveListeners = 64;
  let names: string[];
  try { names = await fs.readdir(directory); } catch { return []; }
  const listeners: AgentAudioTapListener[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix) || name.includes("/")) continue;
    const receipt = path.join(directory, name);
    try {
      const info = await fs.lstat(receipt);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 4_096) continue;
      const value = JSON.parse(await fs.readFile(receipt, "utf8")) as Record<string, unknown>;
      if (!isListenerReceipt(value)) continue;
      const updatedAt = Date.parse(value.updatedAt);
      if (!Number.isFinite(updatedAt) || now - updatedAt < -5_000 || now - updatedAt > maximumAgeMs) continue;
      listeners.push({ tapId: value.tapId, trackName: value.trackName, trackType: value.trackType,
        canonicalParent: value.canonicalParent, updatedAt: value.updatedAt });
    } catch { /* A concurrent Max status write is not an available listener. */ }
  }
  return listeners.sort((a, b) => a.tapId.localeCompare(b.tapId)).slice(0, maximumLiveListeners);
}

function listenerNameKey(listener: AgentAudioTapListener): string {
  return listener.trackName.trim().toLocaleLowerCase();
}

export function agentAudioTapListenersForReasoning(
  listeners: readonly AgentAudioTapListener[],
): AgentAudioTapListenerReasoningView[] {
  const nameCounts = new Map<string, number>();
  for (const listener of listeners) {
    const key = listenerNameKey(listener);
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  return listeners.map((listener) => ({
    tapId: listener.tapId,
    trackName: listener.trackName,
    trackType: listener.trackType,
    canonicalParent: listener.canonicalParent,
    ambiguousName: (nameCounts.get(listenerNameKey(listener)) ?? 0) > 1,
  }));
}

export function formatAgentAudioTapListenersForReasoning(
  listeners: readonly AgentAudioTapListener[],
): string {
  const views = agentAudioTapListenersForReasoning(listeners);
  if (views.length === 0) return "";
  const lines = [
    "Live AgentAudioTap listeners (read-only, fresh registry):",
    "Use these only to reason about which live listener a later explicit capture request should target. If a name is ambiguous, ask or inspect before choosing.",
    ...views.map((listener) => [
      `- tapId: ${listener.tapId}`,
      `trackName: ${JSON.stringify(listener.trackName)}`,
      `trackType: ${listener.trackType}`,
      `canonicalParent: ${JSON.stringify(listener.canonicalParent)}`,
      `ambiguousName: ${listener.ambiguousName ? "true" : "false"}`,
    ].join("; ")),
  ];
  return lines.join("\n");
}

export function resolveAgentAudioTapListener(listeners: readonly AgentAudioTapListener[], tapId: string): AgentAudioTapListener {
  requireSafeStorageId(tapId, "AgentAudioTap target ID");
  const listener = listeners.find((candidate) => candidate.tapId === tapId);
  if (!listener) throw new AgentAudioTapCaptureError("The selected AgentAudioTap listener is not online.");
  return listener;
}

export type AgentAudioTapSessionCaptureTarget =
  | { kind: "main" }
  | { kind: "listener"; tapId: string };

export interface AgentAudioTapListenerSelector {
  listenerName?: string;
  tapId?: string;
}

export function resolveAgentAudioTapCaptureTarget(
  listeners: readonly AgentAudioTapListener[],
  selector: AgentAudioTapListenerSelector,
): { listener: AgentAudioTapListener; target: AgentAudioTapSessionCaptureTarget } {
  if (selector.listenerName === undefined && selector.tapId === undefined) {
    throw new AgentAudioTapCaptureError("Choose a live AgentAudioTap listener before capturing.");
  }
  const named = selector.listenerName === undefined
    ? listeners
    : listeners.filter((listener) => listenerNameKey(listener) === selector.listenerName!.trim().toLocaleLowerCase());
  if (selector.listenerName !== undefined && named.length === 0) {
    throw new AgentAudioTapCaptureError(`No live AgentAudioTap listener named "${selector.listenerName}" is available.`);
  }
  if (selector.tapId !== undefined) {
    const listener = resolveAgentAudioTapListener(named, selector.tapId);
    return { listener, target: listener.trackType === "main" ? { kind: "main" } : { kind: "listener", tapId: listener.tapId } };
  }
  if (named.length > 1) {
    throw new AgentAudioTapCaptureError(`Multiple live AgentAudioTap listeners are named "${selector.listenerName}". Ask which listener to capture.`);
  }
  const listener = named[0];
  if (!listener) throw new AgentAudioTapCaptureError("No live AgentAudioTap listener is available.");
  return { listener, target: listener.trackType === "main" ? { kind: "main" } : { kind: "listener", tapId: listener.tapId } };
}

/**
 * The one Session-bound capture operation shared by current button commands
 * and future approved model actions. It owns no state: listener records come
 * from the existing registry and capture bytes still enter only through the
 * existing verified artifact-admission path.
 */
export async function captureSessionArrangementWithAgentAudioTap(input: {
  storageDirectory: string;
  sessionId: string;
  signal: AbortSignal;
  target: AgentAudioTapSessionCaptureTarget;
  window: AgentAudioTapArrangementWindow | undefined;
  onProgress?(message: string): Promise<void> | void;
  discoverListeners?: typeof discoverAgentAudioTapListeners;
  capture?: typeof captureArrangementWithAgentAudioTap;
  onLifecycleResult?(result: AgentAudioTapCaptureLifecycleResult): Promise<void> | void;
}): Promise<{
  listener: AgentAudioTapListener;
  artifactRef: string;
  captureId: string;
  durationSeconds: number;
  channels: number;
}> {
  const lifecycle: AgentAudioTapCaptureLifecycleResult = {
    sessionId: input.sessionId,
    requestedListener: input.target.kind,
    requestedTapId: input.target.kind === "listener" ? input.target.tapId : null,
    range: input.window === undefined ? null : { startBeat: input.window.startBeat, endBeat: input.window.endBeat },
    listenerResolved: false,
    armReached: false,
    beginReached: false,
    stopFinalizeReached: false,
    artifactAdmitted: false,
    outcome: "failed",
  };
  let failureStage: NonNullable<AgentAudioTapCaptureLifecycleResult["failureStage"]> = "range_validation";
  const reportLifecycle = async () => {
    try { await input.onLifecycleResult?.(lifecycle); } catch { /* Diagnostics never alter capture behavior. */ }
  };
  try {
    if (!input.window || !Number.isFinite(input.window.startBeat) || !Number.isFinite(input.window.endBeat) ||
        input.window.startBeat < 0 || input.window.endBeat <= input.window.startBeat) {
      throw new AgentAudioTapCaptureError("Automatic listening requires a valid bounded Arrangement selection.");
    }
    failureStage = "listener_resolution";
    const listeners = await (input.discoverListeners ?? discoverAgentAudioTapListeners)();
    const listener = input.target.kind === "listener"
      ? resolveAgentAudioTapListener(listeners, input.target.tapId)
      : listeners.find((candidate) => candidate.trackType === "main");
    if (!listener) throw new AgentAudioTapCaptureError("The Main AgentAudioTap listener is not online.");
    lifecycle.listenerResolved = true;
    const result = await (input.capture ?? captureArrangementWithAgentAudioTap)({
      storageDirectory: input.storageDirectory,
      sessionId: input.sessionId,
      signal: input.signal,
      listener,
      window: input.window,
      ...(input.onProgress === undefined ? {} : { onProgress: input.onProgress }),
      onLifecycleStage(stage) {
        if (stage === "arm") failureStage = "arm";
        if (stage === "arm_reached") lifecycle.armReached = true;
        if (stage === "begin") failureStage = "begin";
        if (stage === "begin_reached") lifecycle.beginReached = true;
        if (stage === "stop_finalize") failureStage = "stop_finalize";
        if (stage === "stop_finalize_reached") lifecycle.stopFinalizeReached = true;
        if (stage === "artifact_admission") failureStage = "artifact_admission";
        if (stage === "artifact_admitted") lifecycle.artifactAdmitted = true;
      },
    });
    lifecycle.outcome = "admitted";
    await reportLifecycle();
    return { listener, ...result };
  } catch (error) {
    lifecycle.failureStage = failureStage;
    lifecycle.failureReason = captureFailureReason(error, input.signal);
    await reportLifecycle();
    throw error;
  }
}

function isListenerReceipt(value: Record<string, unknown>): value is {
  tapId: string; trackName: string; trackType: AgentAudioTapListener["trackType"]; canonicalParent: string;
  online: true; recording: boolean; parentStatus: "ready"; updatedAt: string;
  capture?: AgentAudioTapCaptureReceipt;
} {
  return Object.keys(value).every((key) => ["tapId", "trackName", "trackType", "canonicalParent", "online", "recording", "parentStatus", "updatedAt", "capture"].includes(key)) &&
    isSafeStorageId(value.tapId) && typeof value.trackName === "string" && value.trackName.length > 0 && value.trackName.length <= 256 &&
    ["main", "group", "track", "return"].includes(value.trackType as string) &&
    typeof value.canonicalParent === "string" && value.canonicalParent.length > 0 && value.canonicalParent.length <= 512 &&
    value.online === true && value.parentStatus === "ready" && typeof value.updatedAt === "string" &&
    (value.capture === undefined || isCaptureReceipt(value.capture));
}

function isCaptureReceipt(value: unknown): value is AgentAudioTapCaptureReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => ["id", "captureId", "windowId", "state", "startBeat", "endBeat"].includes(key)) &&
    isSafeStorageId(record.id) && isSafeStorageId(record.captureId) && isSafeStorageId(record.windowId) &&
    ["armed", "recording", "stopped", "failed"].includes(record.state as string) &&
    Number.isFinite(record.startBeat) && Number.isFinite(record.endBeat) &&
    (record.startBeat as number) >= 0 && (record.endBeat as number) > (record.startBeat as number);
}

/**
 * Starts a single targeted listener only after its Max-side transport adapter
 * has acknowledged an armed output path. The existing AgentAudioTap device
 * owns the public Max for Live transport calls and restoration; Smith owns
 * Session admission and never exposes the host WAV path.
 */
export async function captureArrangementWithAgentAudioTap(input: {
  storageDirectory: string;
  sessionId: string;
  signal: AbortSignal;
  listener: AgentAudioTapListener;
  window: AgentAudioTapArrangementWindow;
  onProgress?(message: string): Promise<void> | void;
  commandFile?: string;
  receiptPollIntervalMs?: number;
  receiptPollAttempts?: number;
  settleIntervalMs?: number;
  settleAttempts?: number;
  wait?(milliseconds: number): Promise<void>;
  onLifecycleStage?(stage: AgentAudioTapCaptureLifecycleStage): void;
}): Promise<{ artifactRef: string; captureId: string; durationSeconds: number; channels: number }> {
  if (!Number.isFinite(input.window.startBeat) || !Number.isFinite(input.window.endBeat) ||
    input.window.startBeat < 0 || input.window.endBeat <= input.window.startBeat) {
    throw new AgentAudioTapCaptureError("Automatic listening requires a valid bounded Arrangement selection.");
  }
  const intent: AgentAudioTapCaptureIntent = {
    ...createAgentAudioTapCaptureIntent(input.listener),
    startBeat: input.window.startBeat,
    endBeat: input.window.endBeat,
  };
  const commandFile = input.commandFile ?? path.join(os.homedir(), ".ableton-live-mcp", "agent_audio_tap_command.json");
  const captureDirectory = path.join(input.storageDirectory, "agent-audio-tap-captures");
  const completedPath = path.join(captureDirectory, `${intent.captureId}.wav`);
  const pollIntervalMs = input.receiptPollIntervalMs ?? 100;
  const pollAttempts = input.receiptPollAttempts ?? 1_200;
  const settleIntervalMs = input.settleIntervalMs ?? 250;
  const settleAttempts = input.settleAttempts ?? 20;
  const wait = input.wait ?? waitFor;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || !Number.isInteger(pollAttempts) || pollAttempts < 1 || pollAttempts > 3_600) {
    throw new TypeError("AgentAudioTap listen receipt timing is invalid.");
  }
  let transportMayHaveChanged = false;
  try {
    throwIfAborted(input.signal);
    await fs.mkdir(captureDirectory, { recursive: true, mode: 0o700 });
    const command = (id: string, commandName: AgentAudioTapCommand) => writeAgentAudioTapCommand(commandFile, {
      id, command: commandName, targetTapId: input.listener.tapId,
      ...(commandName === "arm" ? { path: completedPath } : {}),
      captureId: intent.captureId, windowId: intent.windowId!, startBeat: input.window.startBeat, endBeat: input.window.endBeat,
    });
    await input.onProgress?.(`Preparing ${input.listener.trackName} for Arrangement capture…`);
    input.onLifecycleStage?.("arm");
    await command(`${intent.captureId}_arm`, "arm");
    await waitForCaptureReceipt({ commandFile, listener: input.listener, captureId: intent.captureId,
      windowId: intent.windowId!, startBeat: input.window.startBeat, endBeat: input.window.endBeat,
      expected: ["armed"], signal: input.signal, intervalMs: pollIntervalMs, attempts: pollAttempts, wait });
    input.onLifecycleStage?.("arm_reached");
    throwIfAborted(input.signal);
    await input.onProgress?.(`Listening to ${input.listener.trackName} for the selected Arrangement range…`);
    transportMayHaveChanged = true;
    input.onLifecycleStage?.("begin");
    await command(`${intent.captureId}_begin`, "begin");
    input.onLifecycleStage?.("begin_reached");
    input.onLifecycleStage?.("stop_finalize");
    await waitForCaptureReceipt({ commandFile, listener: input.listener, captureId: intent.captureId,
      windowId: intent.windowId!, startBeat: input.window.startBeat, endBeat: input.window.endBeat,
      expected: ["stopped"], signal: input.signal, intervalMs: pollIntervalMs, attempts: pollAttempts, wait });
    input.onLifecycleStage?.("stop_finalize_reached");
    await waitForStableWave(completedPath, input.signal, settleIntervalMs, settleAttempts, wait);
    input.onLifecycleStage?.("artifact_admission");
    const admitted = await admitFinalizedAgentAudioTapCapture({ storageDirectory: input.storageDirectory,
      sessionId: input.sessionId, intent, completedPath, signal: input.signal,
      minimumDurationSeconds: minimumCaptureDurationForWindow(input.window) });
    input.onLifecycleStage?.("artifact_admitted");
    await input.onProgress?.(`${input.listener.trackName} Arrangement capture is saved to this Session for analysis.`);
    return admitted;
  } catch (cause) {
    if (transportMayHaveChanged) {
      try {
        await writeAgentAudioTapCommand(commandFile, { id: `${intent.captureId}_cancel`, command: "cancel",
          targetTapId: input.listener.tapId, captureId: intent.captureId, windowId: intent.windowId!,
          startBeat: input.window.startBeat, endBeat: input.window.endBeat });
      } catch { /* Preserve the primary failure; the device performs restore best-effort. */ }
    }
    try { await fs.rm(completedPath, { force: true }); } catch { /* Smith-owned temporary path only. */ }
    if (cause instanceof AgentAudioTapCaptureError || input.signal.aborted) throw cause;
    throw new AgentAudioTapCaptureError("Automatic Arrangement listening could not be confirmed. No audio artifact was added.", { cause });
  }
}

async function waitForCaptureReceipt(input: {
  commandFile: string; listener: AgentAudioTapListener; captureId: string; windowId: string;
  startBeat: number; endBeat: number; expected: readonly AgentAudioTapCaptureState[];
  signal: AbortSignal; intervalMs: number; attempts: number; wait: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const receiptPath = `${input.commandFile}.${input.listener.tapId}.status.json`;
  for (let attempt = 0; attempt < input.attempts; attempt += 1) {
    await input.wait(input.intervalMs);
    throwIfAborted(input.signal);
    try {
      const info = await fs.lstat(receiptPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 4_096) continue;
      const value = JSON.parse(await fs.readFile(receiptPath, "utf8")) as Record<string, unknown>;
      if (!isListenerReceipt(value) || value.tapId !== input.listener.tapId || !value.capture) continue;
      const capture = value.capture;
      if (capture.captureId !== input.captureId || capture.windowId !== input.windowId ||
        capture.startBeat !== input.startBeat || capture.endBeat !== input.endBeat) continue;
      if (capture.state === "failed") throw new AgentAudioTapCaptureError("AgentAudioTap could not prepare the selected Arrangement capture. No audio artifact was added.");
      if (input.expected.includes(capture.state)) return;
    } catch (error) {
      if (error instanceof AgentAudioTapCaptureError) throw error;
      // A concurrent Max receipt update is not a confirmed state.
    }
  }
  throw new AgentAudioTapCaptureError("AgentAudioTap did not acknowledge the selected Arrangement capture. No audio artifact was added.");
}

/**
 * One bounded, user-initiated Main capture. The unchanged upstream device owns
 * recording; Smith only uses its already-proven command file, then accepts a
 * capture after it has stopped and remained stable through a safe read.
 */
export async function captureMainWithAgentAudioTap(input: {
  storageDirectory: string;
  sessionId: string;
  signal: AbortSignal;
  onProgress?(message: string): Promise<void> | void;
  /** Test seams; production uses the upstream AgentAudioTap command file. */
  commandFile?: string;
  captureWindowMs?: number;
  settleIntervalMs?: number;
  settleAttempts?: number;
  wait?(milliseconds: number): Promise<void>;
  /** A trusted fresh listener record selects one proof device; omitted preserves existing Main behavior. */
  listener?: AgentAudioTapListener;
}): Promise<{ artifactRef: string; captureId: string; durationSeconds: number; channels: number }> {
  const intent = createAgentAudioTapCaptureIntent(input.listener);
  const captureWindowMs = input.captureWindowMs ?? AGENT_AUDIO_TAP_CAPTURE_WINDOW_MS;
  const settleIntervalMs = input.settleIntervalMs ?? 250;
  const settleAttempts = input.settleAttempts ?? 20;
  if (!Number.isInteger(captureWindowMs) || captureWindowMs < 1 || captureWindowMs > 60_000 ||
      !Number.isInteger(settleIntervalMs) || settleIntervalMs < 1 ||
      !Number.isInteger(settleAttempts) || settleAttempts < 2 || settleAttempts > 120) {
    throw new TypeError("AgentAudioTap capture timing is invalid.");
  }
  const commandFile = input.commandFile ?? path.join(
    os.homedir(), ".ableton-live-mcp", "agent_audio_tap_command.json",
  );
  const captureDirectory = path.join(input.storageDirectory, "agent-audio-tap-captures");
  const completedPath = path.join(captureDirectory, `${intent.captureId}.wav`);
  const wait = input.wait ?? waitFor;
  let started = false;
  let stopped = false;
  try {
    throwIfAborted(input.signal);
    await fs.mkdir(captureDirectory, { recursive: true, mode: 0o700 });
    await input.onProgress?.(`${input.listener ? `${input.listener.trackName} listener` : "Main capture"} is armed. Start Live playback now; Smith will stop after 12 seconds.`);
    try {
      await writeAgentAudioTapCommand(commandFile, {
        id: `${intent.captureId}_start`, command: "start", path: completedPath,
        ...(intent.tapId ? { targetTapId: intent.tapId, windowId: intent.windowId } : {}),
      });
      started = true;
    } catch (cause) {
      throw new AgentAudioTapCaptureError(
        "AgentAudioTap capture could not be started. Confirm the upstream device is inserted and enabled on Main.",
        { cause },
      );
    }
    await wait(captureWindowMs);
    throwIfAborted(input.signal);
    await input.onProgress?.("Finalizing Main capture…");
    try {
      await writeAgentAudioTapCommand(commandFile, {
        id: `${intent.captureId}_stop`, command: "stop",
        ...(intent.tapId ? { targetTapId: intent.tapId, windowId: intent.windowId } : {}),
      });
      stopped = true;
    } catch (cause) {
      throw new AgentAudioTapCaptureError("AgentAudioTap capture could not be stopped. No audio artifact was added.", { cause });
    }
    await waitForStableWave(completedPath, input.signal, settleIntervalMs, settleAttempts, wait);
    try {
      const admitted = await admitFinalizedAgentAudioTapCapture({
        storageDirectory: input.storageDirectory,
        sessionId: input.sessionId,
        intent,
        completedPath,
        signal: input.signal,
      });
      await input.onProgress?.(`${input.listener ? `${input.listener.trackName} capture` : "Main capture"} is saved to this Session for analysis.`);
      return admitted;
    } catch (cause) {
      throw new AgentAudioTapCaptureError("AgentAudioTap capture was invalid or changed before admission. No audio artifact was added.", { cause });
    }
  } catch (error) {
    if (started && !stopped) {
      try {
        await writeAgentAudioTapCommand(commandFile, { id: `${intent.captureId}_stop`, command: "stop",
          ...(intent.tapId ? { targetTapId: intent.tapId, windowId: intent.windowId } : {}) });
      } catch {
        // Preserve the first safe failure; a later command error is not more actionable.
      }
    }
    try {
      await fs.rm(completedPath, { force: true });
    } catch {
      // The exact output path is Smith-owned and unreachable from UI/model state.
    }
    if (error instanceof AgentAudioTapCaptureError) throw error;
    if (input.signal.aborted) throw error;
    throw new AgentAudioTapCaptureError("AgentAudioTap capture could not be confirmed. No audio artifact was added.", { cause: error });
  }
}

export async function admitFinalizedAgentAudioTapCapture(input: {
  storageDirectory: string; sessionId: string; intent: AgentAudioTapCaptureIntent;
  completedPath: string; signal: AbortSignal; minimumDurationSeconds?: number;
}): Promise<{ artifactRef: string; captureId: string; durationSeconds: number; channels: number }> {
  requireSafeStorageId(input.intent.captureId, "AgentAudioTap capture ID");
  const before = await fs.stat(input.completedPath);
  const bytes = await copyAudioFileSafely(input.completedPath, input.signal, MAX_AUDIO_ASSET_BYTES);
  const after = await fs.stat(input.completedPath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("AgentAudioTap capture did not remain finalized while being admitted.");
  }
  const asset = await saveAgentAudioTapArtifact(input.storageDirectory, input.sessionId, {
    label: input.intent.trackName ? `${input.intent.trackName} capture from upstream AgentAudioTap` : "Main capture from upstream AgentAudioTap",
    bytes, captureId: input.intent.captureId,
    origin: { kind: "agent_audio_tap", captureId: input.intent.captureId, scope: input.intent.scope,
      tapPosition: input.intent.tapPosition,
      ...(input.intent.startBeat === undefined ? {} : { startBeat: input.intent.startBeat }),
      ...(input.intent.endBeat === undefined ? {} : { endBeat: input.intent.endBeat }),
      ...(input.intent.tapId ? { tapId: input.intent.tapId,
        trackName: input.intent.trackName!, trackType: input.intent.trackType!, canonicalParent: input.intent.canonicalParent!, windowId: input.intent.windowId! } : {}) },
    ...(input.minimumDurationSeconds === undefined ? {} : { minimumDurationSeconds: input.minimumDurationSeconds }),
    signal: input.signal,
  });
  return { artifactRef: asset.id, captureId: input.intent.captureId,
    durationSeconds: asset.durationSeconds, channels: asset.channels };
}

async function waitForStableWave(
  completedPath: string,
  signal: AbortSignal,
  intervalMs: number,
  attempts: number,
  wait: (milliseconds: number) => Promise<void>,
): Promise<void> {
  let previousSize = -1;
  let stableReads = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await wait(intervalMs);
    throwIfAborted(signal);
    try {
      const info = await fs.lstat(completedPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 44) continue;
      stableReads = info.size === previousSize ? stableReads + 1 : 0;
      previousSize = info.size;
      if (stableReads >= 1) return;
    } catch {
      // A missing file is expected until AgentAudioTap finishes its WAV header.
    }
  }
  throw new AgentAudioTapCaptureError("AgentAudioTap capture did not finalize. No audio artifact was added.");
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
