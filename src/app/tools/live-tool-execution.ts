import type { ExtensionContext } from "@ableton-extensions/sdk";
import { type UiMessage } from "../../i18n/ui-message.js";

import {
observationRequestForAction,
type AgentPlan,
} from "../../agent/actions.js";
import {
assertEditScopesAllow,
type EditScope
} from "../../agent/edit-scopes.js";
import {
AgentPartialCompletionError,
AgentSteeringBeforeApplyError,
type AgentActionExecutionOutcome,
type AgentActionPreflightGuard
} from "../../agent/loop.js";
import {
assertSameExistingPlanTargets,
bindAgentPlanTargets,
boundTrackForAction,
liveActionIdentityKeys,
type AgentPlanBindings,
} from "../../live/action-bindings.js";
import {
requiredEditScopesForAction,
requiredEditScopesForPlan,
} from "../../live/action-permissions.js";
import type { LiveConversationContext } from "../../live/context.js";
import {
AgentPlanExecutionError,
executeAgentPlanWithProgress,
} from "../../live/executor.js";
import { observeLive } from "../../live/observer.js";
import {
captureLiveActionPreflightObservation,
type LiveActionPreflightObservation,
type MidiClipPreflightStates,
} from "../../live/preflight.js";
import type { ManagedSampleSource, RequestAudioSampleSources } from "../../live/sample-source.js";
import { addSessionAudioSampleSources } from "../audio/request-audio-sources.js";
import {
materializeMidiArtifactActionPlan
} from "../../plugins/artifacts.js";
import { throwIfAborted } from "../../runtime/host.js";
import {
mergeRequestAudioImportProgress,
prepareRequestAudioSampleSources,
type RequestAudioImportProgress
} from "../audio/request-audio-sources.js";

import type { AgentToolExecutionOptions } from "../../agent/tool-execution.js";
type Api = ExtensionContext<"1.0.0">;

export function createLiveMutationExecution(input: {
  context: Api; interaction: LiveConversationContext; storageDirectory: string | undefined; sessionId: string;
  signal: AbortSignal; assertLiveSetCurrent(): void;
  readEditScopes(): Promise<EditScope[]>; currentEditScopes(): EditScope[];
  requestAudioSources: Map<string, ManagedSampleSource>;
  hasPendingSteering?(): boolean; onProgress(message: UiMessage): Promise<void> | void;
}): Pick<AgentToolExecutionOptions<AgentPlanBindings>, "preflightActions" | "prepareActionPlan" | "executeActions"> {
  const { context, interaction, storageDirectory, sessionId, signal, assertLiveSetCurrent, readEditScopes,
    currentEditScopes, requestAudioSources, hasPendingSteering, onProgress } = input;
  return {
      preflightActions: (plan) =>
        preflightAgentPlan(
          context, interaction, plan, signal,
          undefined, undefined, {
            refresh: async () => { assertLiveSetCurrent(); await readEditScopes(); assertLiveSetCurrent(); },
            assert: (requestedPlan, bindings) => {
              assertLiveSetCurrent();
              assertEditScopesAllow(requiredEditScopesForPlan(context, requestedPlan, bindings), currentEditScopes());
            },
          },
          requestAudioSources,
        ),
      prepareActionPlan: async (toolCall) => {
        const plan = await materializeMidiArtifactActionPlan({ argumentsJson: toolCall.arguments, storageDirectory, sessionId, signal });
        const attachmentIds = plan.actions.flatMap(action => "source" in action && action.source.kind === "session_audio_attachment" ? [action.source.attachmentId] : []);
        await addSessionAudioSampleSources({ context, storageDirectory, sessionId, signal }, requestAudioSources, attachmentIds);
        return plan;
      },
      executeActions: async (plan, rawBindings, revalidateAfterImport) => {
        let bindings = rawBindings as AgentPlanBindings;
        const assertActionBoundary = (actionIndex: number, action: AgentPlan["actions"][number]) => {
          assertLiveSetCurrent();
          assertEditScopesAllow(
            requiredEditScopesForAction(context, action, actionIndex, bindings),
            currentEditScopes(),
          );
          if (hasPendingSteering?.()) {
            throw new AgentSteeringBeforeApplyError(
              "Newer user guidance arrived before the next Live action began. " +
                "The remaining actions in this plan were not executed.",
            );
          }
        };
        let importProgress: RequestAudioImportProgress = {
          results: [],
          keys: [],
        };
        let outcome: AgentActionExecutionOutcome;
        try {
          importProgress = await prepareRequestAudioSampleSources(
            bindings,
            signal,
            () => {
              assertLiveSetCurrent();
              assertEditScopesAllow(
                requiredEditScopesForPlan(context, plan, bindings),
                currentEditScopes(),
              );
              if (hasPendingSteering?.()) {
                throw new AgentSteeringBeforeApplyError(
                  "Newer user guidance arrived while the audio attachment was being imported. " +
                    "The remaining Live actions were not executed.",
                );
              }
            },
          );
          if (importProgress.results.length > 0) {
            bindings = await revalidateAfterImport() as AgentPlanBindings;
          }
          outcome = await executeAgentPlanWithProgress(
            context,
            plan,
            interaction.target,
            signal,
            bindings,
            assertActionBoundary,
          );
          outcome = {
            results: [...importProgress.results, ...outcome.results],
            mutationCount: importProgress.results.length + outcome.mutationCount,
          };
        } catch (caught) {
          const error = mergeRequestAudioImportProgress(importProgress, caught);
          if (
            error instanceof AgentPlanExecutionError &&
            error.cause instanceof AgentSteeringBeforeApplyError &&
            error.completedResults.length === 0 &&
            error.completedMutationCount === 0
          ) {
            throwIfAborted(signal);
            throw error.cause;
          }
          if (
            signal.aborted &&
            error instanceof AgentPlanExecutionError &&
            error.completedResults.length &&
            isAbortCause(error.cause, signal)
          ) {
            outcome = {
              results: error.completedResults,
              mutationCount: error.completedMutationCount,
              incompleteRecovery: {
                completedActionKeys: error.completedActionKeys,
                completedActionCount: error.completedActionCount,
                failureMessage:
                  "The request was stopped before every confirmed Live action completed.",
              },
            };
          } else if (error instanceof AgentPlanExecutionError) {
            throw new AgentPartialCompletionError(
              error.completedResults,
              error.cause,
              error.failedActionIndex,
              error.failedAction,
              error.failedTrackName,
              error.completedActionKeys,
              error.completedMutationCount,
              error.failedTrackSelector,
              error.completedActionCount,
            );
          } else {
            throw error;
          }
        }
        await onProgress("Updating chat history");
        return outcome;
      },
  };
}

function isAbortCause(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  if ("reason" in signal) return error === signal.reason;
  return error instanceof Error && /abort/i.test(error.message);
}

export async function preflightAgentPlan(
  context: Api,
  interaction: LiveConversationContext,
  plan: AgentPlan,
  signal: AbortSignal,
  observer: typeof observeLive = observeLive,
  snapshotter: (
    context: Api,
    action: AgentPlan["actions"][number],
    target: LiveConversationContext["target"],
    requestAudioSources?: RequestAudioSampleSources,
    includePreview?: boolean,
    midiClipStates?: MidiClipPreflightStates,
  ) => string | LiveActionPreflightObservation | Promise<string | LiveActionPreflightObservation> = captureLiveActionPreflightObservation,
  authorization?: {
    refresh(): Promise<unknown>;
    assert(plan: AgentPlan, bindings: AgentPlanBindings): void;
  },
  requestAudioSources?: RequestAudioSampleSources,
): Promise<AgentActionPreflightGuard<AgentPlanBindings>> {
  await authorization?.refresh();
  const initialBindings = bindAgentPlanTargets(
    context,
    plan,
    interaction.target,
    requestAudioSources,
  );
  const initialSnapshots = await captureAgentPlanPreflightSnapshots(
    context,
    interaction,
    plan,
    signal,
    observer,
    snapshotter,
    initialBindings,
    requestAudioSources,
    plan.actions.length === 1,
  );
  authorization?.assert(plan, withPreflightParameters(initialBindings, initialSnapshots));

  const guard: AgentActionPreflightGuard<AgentPlanBindings> = async () => {
    await authorization?.refresh();
    const currentBindings = bindAgentPlanTargets(
      context,
      plan,
      interaction.target,
      requestAudioSources,
    );
    assertSameExistingPlanTargets(initialBindings, currentBindings);
    const currentSnapshots = await captureAgentPlanPreflightSnapshots(
      context,
      interaction,
      plan,
      signal,
      observer,
      snapshotter,
      currentBindings,
      requestAudioSources,
    );
    const changedIndex = currentSnapshots.findIndex(
      (snapshot, index) => snapshot.fingerprint !== initialSnapshots[index]?.fingerprint,
    );
    if (
      changedIndex !== -1 ||
      currentSnapshots.length !== initialSnapshots.length
    ) {
      const actionNumber = changedIndex === -1 ? 1 : changedIndex + 1;
      throw new Error(
        `Live target or relevant state changed for action ${actionNumber} while confirmation was open. Inspect the current Live state and try again.`,
      );
    }
    const bindings = withPreflightParameters(currentBindings, currentSnapshots);
    authorization?.assert(plan, bindings);
    return bindings;
  };
  Object.defineProperty(guard, "actionKeys", {
    enumerable: true,
    value: planActionIdentityKeys(plan, initialBindings),
  });
  const preview = plan.actions.length === 1 ? initialSnapshots[0]?.preview : undefined;
  if (preview) {
    Object.defineProperty(guard, "previews", { enumerable: true, value: [preview] });
  }
  return guard;
}

function withPreflightParameters(
  bindings: AgentPlanBindings,
  snapshots: readonly LiveActionPreflightObservation[],
): AgentPlanBindings {
  return {
    ...bindings,
    actionObjects: new Map([...bindings.actionObjects].map(([index, objects]) => {
      const parameterValues = snapshots[index]?.executionParameters;
      return [index, parameterValues ? { ...objects, parameterValues } : objects];
    })),
  };
}

function planActionIdentityKeys(
  plan: AgentPlan,
  bindings: AgentPlanBindings,
): string[][] {
  const aliases = new Map(
    Object.entries(plan.targets ?? {}).flatMap(([ref, target]) =>
      target.trackName ? [[ref, target.trackName] as const] : []
    ),
  );
  return plan.actions.map((action, actionIndex) => {
    const boundTrack = boundTrackForAction(action, actionIndex, bindings);
    const trackAliases: string[] = [];
    if ("trackRef" in action && action.trackRef) {
      const alias = aliases.get(action.trackRef);
      if (alias) trackAliases.push(alias);
    } else if ("trackName" in action && action.trackName) {
      trackAliases.push(action.trackName);
    }
    const target = "trackRef" in action && action.trackRef
      ? plan.targets?.[action.trackRef]
      : undefined;
    const nonRegularTrack = target?.trackRole === "return"
      ? { role: "return" as const }
      : target?.trackRole === "main"
        ? { role: "main" as const }
        : undefined;
    const keys = liveActionIdentityKeys(
      action,
      boundTrack,
      trackAliases,
      nonRegularTrack,
    );
    if (
      (action.type === "create_midi_track" || action.type === "create_audio_track") &&
      action.ref &&
      action.name
    ) {
      aliases.set(action.ref, action.name);
    }
    if (action.type === "rename_track" && action.trackRef) {
      aliases.set(action.trackRef, action.newName);
    } else if (action.type === "rename_track" && action.trackName) {
      for (const [ref, name] of aliases) {
        if (normalizedIdentityText(name) === normalizedIdentityText(action.trackName)) {
          aliases.set(ref, action.newName);
        }
      }
    }
    return keys;
  });
}

function normalizedIdentityText(value: string): string {
  return value.trim().toLowerCase();
}

async function captureAgentPlanPreflightSnapshots(
  context: Api,
  interaction: LiveConversationContext,
  plan: AgentPlan,
  signal: AbortSignal,
  observer: typeof observeLive,
  snapshotter: (
    context: Api,
    action: AgentPlan["actions"][number],
    target: LiveConversationContext["target"],
    requestAudioSources?: RequestAudioSampleSources,
    includePreview?: boolean,
    midiClipStates?: MidiClipPreflightStates,
  ) => string | LiveActionPreflightObservation | Promise<string | LiveActionPreflightObservation>,
  bindings: AgentPlanBindings,
  requestAudioSources?: RequestAudioSampleSources,
  includePreview = false,
): Promise<LiveActionPreflightObservation[]> {
  const snapshots: LiveActionPreflightObservation[] = [];
  const midiClipStates: MidiClipPreflightStates = new Map();
  for (const [actionIndex, action] of plan.actions.entries()) {
    throwIfAborted(signal);
    const boundTrack = boundTrackForAction(action, actionIndex, bindings);
    if ("trackRef" in action && action.trackRef && !boundTrack) {
      snapshots.push({ fingerprint: `deferred:${action.type}:${action.trackRef}` });
      continue;
    }
    const actionTarget = boundTrack
      ? { ...interaction.target, track: boundTrack }
      : interaction.target;
    await observer(
      context,
      observationRequestForAction(action),
      actionTarget,
    );
    throwIfAborted(signal);
    const captured = await snapshotter(
      context,
      action,
      actionTarget,
      requestAudioSources,
      includePreview,
      midiClipStates,
    );
    snapshots.push(typeof captured === "string" ? { fingerprint: captured } : captured);
    throwIfAborted(signal);
  }
  return snapshots;
}
