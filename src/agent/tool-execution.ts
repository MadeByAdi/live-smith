import { createHash,randomUUID } from "node:crypto";
import type { ModelCitation,ModelHostedWebSearch,ModelToolCall,ModelToolInputPart } from "../model/contracts.js";
import { throwIfAborted } from "../runtime/host.js";
import type { AgentApplyOperation } from "./action-preview.js";
import { observationRequestForAction,summarizeActionPlan,summarizeAgentAction,type AgentAction,type AgentObservationRequest,type AgentPlan,type ObservationTrackSelector } from "./actions.js";
import type { ArtifactRef } from "./artifact-contracts.js";
import { EditScopeDeniedError } from "./edit-scopes.js";
import { progressLabelForActionPlan,progressLabelForToolCall } from "./progress.js";
import { MAX_FINAL_RECOVERY_ADMISSION_DIGESTS,MAX_STAGED_RECOVERY_ACTION_DIGESTS } from "./recovery-contract.js";
import { actionPlanFromToolCall,assertOnlyKeys,isObservationTool,observationRequestFromToolCall,parseToolArguments } from "./tool-call-parser.js";
import { externalToolOutcome,type ToolResultOutcome } from "./tool-outcome.js";

export type AgentLoopTraceEvent =
  | { kind: "assistant"; content: string; citations?: ModelCitation[] }
  | { kind: "reasoning"; content: string }
  | {
      kind: "web_search";
      content: string;
      webSearch: ModelHostedWebSearch;
    }
  | { kind: "tool_call"; name: string; content: string }
  | { kind: "tool_result"; name: string; content: string; outcome: ToolResultOutcome; artifacts?: ArtifactRef[] }
  | { kind: "apply_requested"; content: string; applyOperation?: AgentApplyOperation }
  | { kind: "apply_auto_approved"; content: string; applyOperation?: AgentApplyOperation }
  | {
      kind: "apply_result";
      content: string;
      recovery?: AgentRecoveryLedgerUpdate;
      applyOperation?: AgentApplyOperation;
    }
  | { kind: "error"; content: string };

export type AgentConfirmationDecision =
  | { confirmed: boolean; source: "user" }
  | {
      confirmed: true;
      source: "automatic";
      mode: "low-risk" | "everything";
    };

export interface AgentRecoveryLedgerUpdate {
  active: boolean;
  completedActionDigests: string[];
}

export interface AgentLoopInitialRecoveryState {
  completedActionDigests: readonly string[];
  unresolvedFailure: string;
  unconfirmedMutation?: boolean;
}

export interface AgentActionExecutionOutcome {
  results: string[];
  mutationCount: number;
  incompleteRecovery?: {
    completedActionKeys: readonly (readonly string[])[];
    /** Fully completed plan actions; preparation side effects are excluded. */
    completedActionCount: number;
    failureMessage: string;
  };
}

export interface AgentActionPreflightGuard<ExecutionBindings = undefined> {
  (): Promise<ExecutionBindings>;
  readonly actionKeys?: readonly (readonly string[])[];
  readonly previews?: import("./action-preview.js").AgentActionPreview[];
}

export interface AgentToolExecutionOptions<ExecutionBindings = undefined> {
  admittedToolNames?: readonly string[];
  externalTools?: { names: readonly string[]; execute(call: ModelToolCall): Promise<AgentExternalToolResult> };
  signal?: AbortSignal;
  hasPendingSteering?(): boolean;
  onModelInputPartAccepted?(part: ModelToolInputPart): void;
  observe(request: AgentObservationRequest): Promise<string | { content: string; modelInputPart: ModelToolInputPart }>;
  preflightActions?(plan: AgentPlan): Promise<AgentActionPreflightGuard<ExecutionBindings>>;
  prepareActionPlan?(toolCall: ModelToolCall): Promise<AgentPlan>;
  confirmActions(plan: AgentPlan, guard: AgentActionPreflightGuard<ExecutionBindings>, operationId: string): Promise<boolean | AgentConfirmationDecision>;
  confirmRecoveryResolution?(message: string): Promise<boolean>;
  withActionExecutionLock?(operation: () => Promise<AgentActionExecutionOutcome>): Promise<AgentActionExecutionOutcome>;
  executeActions(plan: AgentPlan, bindings: ExecutionBindings, revalidateActions: AgentActionPreflightGuard<ExecutionBindings>): Promise<AgentActionExecutionOutcome>;
  onProgress?(message: string): Promise<void> | void;
  onEvent?(event: AgentLoopTraceEvent): Promise<void> | void;
}

export function createAgentRecoveryState(initial?: AgentLoopInitialRecoveryState): AgentRecoveryState {
  return { completedActionDigests: new Set(initial?.completedActionDigests ?? []),
    requiresExplicitResolution: initial !== undefined, requiredObservation: undefined,
    requiresLiveSetObservationForResolution: initial !== undefined, unresolvedFailure: initial?.unresolvedFailure,
    requiresOutcomeReconciliation: initial?.unconfirmedMutation ?? false };
}

export class AgentActionPreflightError extends Error {
  constructor(
    message: string,
    cause: unknown,
    readonly recoverable: boolean,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AgentActionPreflightError";
  }
}

export class AgentApplyResultReportingError extends Error {
  readonly completedResults: string[];

  constructor(completedResults: string[], cause: unknown) {
    super([
      completedResults.length
        ? "Live operations completed, but their apply result could not be recorded."
        : "The Live action failure could not be recorded.",
      ...completedResults.map((result) => `Completed: ${result}`),
      completedResults.length
        ? "The completed operations will not be retried automatically."
        : "No operations from this plan were completed.",
      errorMessage(cause),
    ].join(" "), { cause });
    this.name = "AgentApplyResultReportingError";
    this.completedResults = [...completedResults];
  }
}

export class AgentRecoveryResolutionReportingError extends Error {
  constructor(cause: unknown) {
    super(
      "The recovery resolution outcome could not be confirmed. Reload authoritative Session state before continuing.",
      { cause },
    );
    this.name = "AgentRecoveryResolutionReportingError";
  }
}

class AgentRecoveryResolutionSteeringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRecoveryResolutionSteeringError";
  }
}

export class AgentPartialCompletionError extends Error {
  readonly completedResults: string[];

  constructor(
    completedResults: string[],
    cause: unknown,
    readonly failedActionIndex?: number,
    readonly failedAction?: AgentAction,
    readonly failedTrackName?: string,
    readonly completedActionKeys: readonly (readonly string[])[] = [],
    readonly completedMutationCount: number = completedResults.length,
    readonly failedTrackSelector?: ObservationTrackSelector | null,
    readonly completedActionCount: number = 0,
  ) {
    super([
      completedResults.length
        ? `Live action plan partially completed after ${completedResults.length} operation(s).`
        : "Live action plan could not complete its first operation.",
      ...completedResults.map((result) => `Completed: ${result}`),
      failedActionIndex !== undefined && failedAction
        ? `Failed action ${failedActionIndex + 1}: ${summarizeAgentAction(failedAction)}`
        : "",
      completedResults.length
        ? "The completed operations will not be retried automatically."
        : "No operations from this plan were completed.",
      errorMessage(cause),
    ].filter(Boolean).join("\n"), { cause });
    this.name = "AgentPartialCompletionError";
    this.completedResults = [...completedResults];
  }
}

export interface AgentRecoveryState {
  requiresOutcomeReconciliation?: boolean;
  readonly completedActionDigests: Set<string>;
  requiresExplicitResolution: boolean;
  requiredObservation: AgentObservationRequest | undefined;
  requiresLiveSetObservationForResolution: boolean;
  unresolvedFailure: string | undefined;
}

export interface ToolCallExecutionResult {
  artifacts?: ArtifactRef[];
  outcomeUnknown?: boolean;
  toolContent: string;
  userMessage: string;
  modelInputPart?: ModelToolInputPart;
  cancelled: boolean;
  failed: boolean;
  mutationProgress: boolean;
  progressKey?: string;
  failureKind?: "arguments" | "observation" | "host" | "internal" | "external";
}

export interface AgentExternalToolResult {
  content: string;
  artifacts?: ArtifactRef[];
  failed?: boolean;
  outcomeUnknown?: boolean;
  invalidArguments?: boolean;
  /** Binary input supplied to the next model turn only after the text result is recorded. */
  modelInputPart?: ModelToolInputPart;
  /** Ends this send without retrying an operation with external side effects. */
  stop?: boolean;
  progressKey?: string;
}

export class AgentExternalToolReportingError extends Error {
  constructor(public readonly outcome?: AgentExternalToolResult) {
    super("An external tool could not finish reporting its outcome. It will not be executed again automatically; check its saved job before continuing.");
    this.name = "AgentExternalToolReportingError";
  }
}

class AgentRecoveryPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRecoveryPlanError";
  }
}

class AgentToolArgumentsError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "AgentToolArgumentsError";
  }
}

class AgentObservationError extends Error {
  constructor(readonly request: AgentObservationRequest, cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "AgentObservationError";
  }
}

export class AgentSteeringBeforeApplyError extends Error {
  constructor(
    message =
      "The proposed Live actions were not applied because a newer user steering message superseded the plan.",
  ) {
    super(message);
    this.name = "AgentSteeringBeforeApplyError";
  }
}

export async function executeAgentTool(
  options: AgentToolExecutionOptions<unknown>,
  toolCall: ModelToolCall,
  recoveryState: AgentRecoveryState,
): Promise<ToolCallExecutionResult> {
  await options.onProgress?.(progressLabelForToolCall(toolCall));
  await emitTraceEvent(options, { kind: "tool_call", name: toolCall.name, content: toolCall.arguments });
  let applyPlan: AgentPlan | undefined;
  let operationId: string | undefined;
  let applyResultRecorded = false;
  const recordApplyResult = async (
    content: string,
    status: "applied" | "partial" | "cancelled" | "failed",
    recovery?: AgentRecoveryLedgerUpdate,
  ) => {
    await emitTraceEvent(options, {
      kind: "apply_result", content,
      ...(operationId ? { applyOperation: { id: operationId, status } } : {}),
      ...(recovery ? { recovery } : {}),
    });
    applyResultRecorded = true;
  };
  let applyActionKeys: readonly (readonly string[])[] | undefined;
  try {
    if (options.admittedToolNames && !options.admittedToolNames.includes(toolCall.name)) {
      throw new AgentToolArgumentsError(new Error("This tool is not admitted for the current request."));
    }
    if (options.externalTools?.names.includes(toolCall.name)) {
      throwIfAborted(options.signal);
      let result: AgentExternalToolResult;
      try {
        result = await options.externalTools.execute(toolCall);
      } catch {
        throwIfAborted(options.signal);
        throw new AgentExternalToolReportingError();
      }
      try {
        await emitTraceEvent(options, {
          kind: "tool_result", name: toolCall.name, content: result.content, outcome: externalToolOutcome(result),
          ...(result.artifacts ? { artifacts: result.artifacts } : {}),
        });
      } catch {
        const { modelInputPart: _privateModelInput, ...safeOutcome } = result;
        throw new AgentExternalToolReportingError(safeOutcome);
      }
      if (result.modelInputPart) options.onModelInputPartAccepted?.(result.modelInputPart);
      return {
        toolContent: result.content, userMessage: result.content,
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
        ...(result.outcomeUnknown ? { outcomeUnknown: true } : {}),
        ...(result.modelInputPart ? { modelInputPart: result.modelInputPart } : {}),
        cancelled: result.stop ?? false, failed: result.failed ?? false,
        mutationProgress: false,
        ...(result.progressKey === undefined ? {} : { progressKey: result.progressKey }),
        ...(result.failed ? { failureKind: result.invalidArguments ? "arguments" as const : "external" as const } : {}),
      };
    }
    if (isObservationTool(toolCall.name)) {
      let request: AgentObservationRequest;
      try {
        request = observationRequestFromToolCall(toolCall);
      } catch (error) {
        throw new AgentToolArgumentsError(error);
      }
      throwIfAborted(options.signal);
      let rawObservation: Awaited<ReturnType<typeof options.observe>>;
      try {
        rawObservation = await options.observe(request);
      } catch (error) {
        throw new AgentObservationError(request, error);
      }
      const observation = typeof rawObservation === "string"
        ? rawObservation
        : rawObservation.content;
      const modelInputPart = typeof rawObservation === "string"
        ? undefined
        : rawObservation.modelInputPart;
      throwIfAborted(options.signal);
      if (
        recoveryState.requiredObservation &&
        observationCoversRecovery(request, recoveryState.requiredObservation)
      ) {
        recoveryState.requiredObservation = undefined;
      } else if (
        recoveryState.requiresLiveSetObservationForResolution &&
        request.type === "inspect_live_set"
      ) {
        recoveryState.requiresLiveSetObservationForResolution = false;
      }
      await emitTraceEvent(options, {
        kind: "tool_result",
        name: toolCall.name,
        content: observation,
        outcome: "success",
      });
      if (modelInputPart) options.onModelInputPartAccepted?.(modelInputPart);
      return {
        toolContent: observation,
        userMessage: observation,
        ...(modelInputPart ? { modelInputPart } : {}),
        cancelled: false,
        failed: false,
        mutationProgress: false,
        progressKey: observation,
      };
    }

    if (toolCall.name === "resolve_live_recovery") {
      try {
        assertOnlyKeys(
          parseToolArguments(toolCall.arguments),
          [],
          `${toolCall.name} arguments`,
        );
      } catch (error) {
        throw new AgentToolArgumentsError(error);
      }
      if (
        recoveryState.unresolvedFailure === undefined ||
        !recoveryState.requiresExplicitResolution
      ) {
        throw new AgentRecoveryPlanError(
          "resolve_live_recovery is available only while this Session has an active unfinished Live operation.",
        );
      }
      if (
        recoveryState.requiredObservation !== undefined ||
        recoveryState.requiresLiveSetObservationForResolution
      ) {
        throw new AgentRecoveryPlanError(
          recoveryState.requiresLiveSetObservationForResolution
            ? "Inspect the current Live Set successfully with inspect_live_set in this request before asking the user to close the recovered operation."
            : "Complete the required recovery observation successfully before asking the user to close the unfinished operation.",
        );
      }
      if (!options.confirmRecoveryResolution) {
        throw new AgentRecoveryPlanError(
          "Recovery resolution confirmation is unavailable; the unfinished operation remains active.",
        );
      }
      const confirmationMessage =
        "Keep the Live changes already completed and close this unfinished operation? Any unfinished steps will be abandoned. This does not undo anything and does not perform a Live mutation.";
      throwIfAborted(options.signal);
      if (options.hasPendingSteering?.()) {
        throw new AgentRecoveryResolutionSteeringError(
          "The recovery resolution was not requested because newer user guidance arrived.",
        );
      }
      const confirmed = await options.confirmRecoveryResolution(
        confirmationMessage,
      );
      throwIfAborted(options.signal);
      if (options.hasPendingSteering?.()) {
        throw new AgentRecoveryResolutionSteeringError(
          "The recovery resolution was not accepted because newer user guidance arrived.",
        );
      }
      if (!confirmed) {
        const content =
          "The user kept the unfinished operation active. No Live changes were made, and the replay-protection ledger remains in force.";
        await emitTraceEvent(options, {
          kind: "tool_result", outcome: "stopped",
          name: toolCall.name,
          content,
        });
        return {
          toolContent: content,
          userMessage: content,
          cancelled: true,
          failed: false,
          mutationProgress: false,
        };
      }
      const content =
        "Kept the completed Live changes and closed the unfinished operation. Unfinished steps were abandoned. Nothing was undone, and no Live mutation was performed.";
      try {
        await emitTraceEvent(options, {
          kind: "apply_result",
          content,
          recovery: { active: false, completedActionDigests: [] },
        });
      } catch (error) {
        throw new AgentRecoveryResolutionReportingError(error);
      }
      recoveryState.unresolvedFailure = undefined;
      recoveryState.requiresOutcomeReconciliation = false;
      recoveryState.completedActionDigests.clear();
      recoveryState.requiresExplicitResolution = false;
      recoveryState.requiredObservation = undefined;
      recoveryState.requiresLiveSetObservationForResolution = false;
      return {
        toolContent: content,
        userMessage: content,
        cancelled: true,
        failed: false,
        mutationProgress: false,
      };
    }

    if (toolCall.name === "apply_live_actions") {
      if (recoveryState.requiresOutcomeReconciliation) {
        throw new AgentRecoveryPlanError("A previous Live operation ended before its result was confirmed. Inspect the current Live Set, then use resolve_live_recovery for the user to reconcile its effects before submitting further Live changes.");
      }
      let plan: AgentPlan;
      try {
        plan = options.prepareActionPlan
          ? await options.prepareActionPlan(toolCall)
          : actionPlanFromToolCall(toolCall);
      } catch (error) {
        throw new AgentToolArgumentsError(error);
      }
      applyPlan = plan;
      if (plan.resolvesPriorFailure && !recoveryState.unresolvedFailure) {
        throw new AgentRecoveryPlanError(
          "resolvesPriorFailure is only valid while this Session has an unfinished Live operation. Omit it for normal work.",
        );
      }
      if (recoveryState.requiredObservation) {
        throw new AgentRecoveryPlanError(
          "Live state could not be refreshed after the previous partial apply. Inspect the affected Live object successfully before proposing another mutation.",
        );
      }
      const repeatedActionIndex = plan.actions.findIndex((action) =>
        hasCompletedActionIdentity(recoveryState, agentActionKey(action))
      );
      if (repeatedActionIndex >= 0) {
        throw new AgentRecoveryPlanError(
          `Action ${repeatedActionIndex + 1} repeats work already completed in this Session's unfinished operation: ${summarizeAgentAction(plan.actions[repeatedActionIndex]!)} Continue with missing work only.`,
        );
      }
      if (!options.preflightActions) {
        throw new AgentActionPreflightError(
          "Action preflight is not configured; refusing to confirm or execute Live actions.",
          undefined,
          false,
        );
      }
      let revalidateActions: AgentActionPreflightGuard<unknown>;
      try {
        revalidateActions = await options.preflightActions(plan);
        if (typeof revalidateActions !== "function") {
          throw new AgentActionPreflightError(
            "Action preflight did not return a revalidation guard; refusing to confirm or execute Live actions.",
            undefined,
            false,
          );
        }
        applyActionKeys = revalidateActions.actionKeys;
        const repeatedSemanticActionIndex = applyActionKeys?.findIndex((keys) =>
          keys.some((key) => hasCompletedActionIdentity(recoveryState, key))
        ) ?? -1;
        if (repeatedSemanticActionIndex >= 0) {
          throw new AgentRecoveryPlanError(
            `Action ${repeatedSemanticActionIndex + 1} repeats work already completed in this Session's unfinished operation: ${summarizeAgentAction(plan.actions[repeatedSemanticActionIndex]!)} Continue with missing work only.`,
          );
        }
        assertRecoveryLedgerHasCapacity(
          recoveryState,
          plan,
          applyActionKeys,
        );
        throwIfAborted(options.signal);
      } catch (error) {
        throwIfAborted(options.signal);
        if (
          error instanceof AgentActionPreflightError ||
          error instanceof AgentRecoveryPlanError ||
          error instanceof EditScopeDeniedError
        ) throw error;
        throw new AgentActionPreflightError(
          `Action preflight failed: ${errorMessage(error)}`,
          error,
          true,
        );
      }
      const summary = summarizeActionPlan(plan);
      await options.onProgress?.(progressLabelForActionPlan(plan));
      operationId = `apply_${randomUUID()}`;
      await emitTraceEvent(options, {
        kind: "apply_requested",
        content: summary,
        applyOperation: { id: operationId, status: "proposed", plan,
          ...(revalidateActions.previews ? { previews: revalidateActions.previews } : {}) },
      });
      if (options.hasPendingSteering?.()) {
        throw new AgentSteeringBeforeApplyError();
      }
      throwIfAborted(options.signal);
      const rawDecision = await options.confirmActions(plan, revalidateActions, operationId);
      const decision: AgentConfirmationDecision = typeof rawDecision === "boolean"
        ? { confirmed: rawDecision, source: "user" }
        : rawDecision;
      throwIfAborted(options.signal);
      if (options.hasPendingSteering?.()) {
        throw new AgentSteeringBeforeApplyError();
      }

      if (decision.confirmed && decision.source === "automatic") {
        const actionCount = plan.actions.length;
        const modeLabel = decision.mode === "everything"
          ? "Accept Everything"
          : "Low Risk";
        await emitTraceEvent(options, {
          kind: "apply_auto_approved",
          applyOperation: { id: operationId, status: "approved" },
          content: [
            `${actionCount} ${actionCount === 1 ? "change" : "changes"} · ${modeLabel}`,
            "Automatic approval. Standard safety checks completed.",
          ].join("\n"),
        });
        throwIfAborted(options.signal);
      }

      if (!decision.confirmed) {
        const content = "User cancelled the proposed Live actions. Do not claim they were applied.";
        await recordApplyResult(content, "cancelled");
        return {
          toolContent: content,
          userMessage: `${summary}\n\nActions were not applied.`,
          cancelled: true,
          failed: false,
          mutationProgress: false,
        };
      }

      const executeConfirmedActions = async () => {
        throwIfAborted(options.signal);
        if (options.hasPendingSteering?.()) {
          throw new AgentSteeringBeforeApplyError();
        }
        let bindings: unknown;
        try {
          bindings = await revalidateActions();
          throwIfAborted(options.signal);
          if (options.hasPendingSteering?.()) {
            throw new AgentSteeringBeforeApplyError();
          }
        } catch (error) {
          throwIfAborted(options.signal);
          if (
            error instanceof AgentSteeringBeforeApplyError ||
            error instanceof EditScopeDeniedError
          ) throw error;
          throw new AgentActionPreflightError(
            `Live state changed after confirmation; refusing to execute actions: ${errorMessage(error)}`,
            error,
            true,
          );
        }
        return options.executeActions(
          plan,
          bindings,
          revalidateActions,
        );
      };
      const outcome = options.withActionExecutionLock
        ? await options.withActionExecutionLock(executeConfirmedActions)
        : await executeConfirmedActions();
      if (outcome.incompleteRecovery) {
        const recovery = outcome.incompleteRecovery;
        if (
          !Number.isInteger(recovery.completedActionCount) ||
          recovery.completedActionCount < 0 ||
          recovery.completedActionCount > plan.actions.length
        ) {
          throw new Error("Live action execution returned an invalid completed-action count.");
        }
        for (const action of plan.actions.slice(0, recovery.completedActionCount)) {
          rememberCompletedActionIdentity(recoveryState, agentActionKey(action));
        }
        for (const keys of recovery.completedActionKeys) {
          for (const key of keys) rememberCompletedActionIdentity(recoveryState, key);
        }
        const content = [
          `Live action plan partially completed after ${outcome.results.length} operation(s).`,
          ...outcome.results.map((item) => `Completed: ${item}`),
          "The completed operations will not be retried automatically.",
          recovery.failureMessage,
        ].join("\n");
        recoveryState.unresolvedFailure = content;
        recoveryState.requiresExplicitResolution ||= outcome.mutationCount > 0;
        if (outcome.mutationCount > 0) {
          recoveryState.requiredObservation = undefined;
          recoveryState.requiresLiveSetObservationForResolution = true;
        }
        const recoveryUpdate = recoveryState.requiresExplicitResolution
          ? recoveryLedgerUpdate(recoveryState)
          : undefined;
        try {
          await recordApplyResult(content, outcome.mutationCount > 0 ? "partial" : options.signal?.aborted ? "cancelled" : "failed", recoveryUpdate);
        } catch (error) {
          throw new AgentApplyResultReportingError(outcome.results, error);
        }
        throwIfAborted(options.signal);
        return {
          toolContent: content,
          userMessage: content,
          cancelled: false,
          failed: true,
          mutationProgress: outcome.mutationCount > 0,
          failureKind: "host",
        };
      }
      const content = ["Applied:", ...outcome.results.map((item) => `- ${item}`)].join("\n");
      const recoveryActive = recoveryState.unresolvedFailure !== undefined;
      const clearsRecovery = recoveryActive && (
        plan.resolvesPriorFailure === true ||
        !recoveryState.requiresExplicitResolution
      );
      if (recoveryActive && !clearsRecovery) {
        for (const [index, action] of plan.actions.entries()) {
          rememberCompletedActionIdentity(recoveryState, agentActionKey(action));
          for (const key of applyActionKeys?.[index] ?? []) {
            rememberCompletedActionIdentity(recoveryState, key);
          }
        }
        if (outcome.mutationCount > 0) {
          recoveryState.requiredObservation = undefined;
          recoveryState.requiresLiveSetObservationForResolution = true;
        }
      }
      const recoveryUpdate = clearsRecovery
        ? recoveryState.requiresExplicitResolution
          ? { active: false, completedActionDigests: [] }
          : undefined
        : recoveryActive
          ? recoveryLedgerUpdate(recoveryState)
          : undefined;
      try {
        await recordApplyResult(content, "applied", recoveryUpdate);
      } catch (error) {
        throw new AgentApplyResultReportingError(outcome.results, error);
      }
      throwIfAborted(options.signal);
      if (clearsRecovery) {
        recoveryState.unresolvedFailure = undefined;
        recoveryState.completedActionDigests.clear();
        recoveryState.requiresExplicitResolution = false;
        recoveryState.requiredObservation = undefined;
        recoveryState.requiresLiveSetObservationForResolution = false;
      }
      return {
        toolContent: content,
        userMessage: content,
        cancelled: false,
        failed: false,
        mutationProgress: outcome.mutationCount > 0,
      };
    }

    throw new Error(`Unsupported model tool call: ${toolCall.name}`);
  } catch (error) {
    // An established Apply owns its terminal activity; model diagnostics remain separate.
    if (operationId && !applyResultRecorded &&
      !(error instanceof AgentPartialCompletionError) &&
      !(error instanceof AgentApplyResultReportingError)) {
      await recordApplyResult(errorMessage(error),
        options.signal?.aborted || error instanceof AgentSteeringBeforeApplyError ? "cancelled" : "failed");
    }
    const scopeDenial = error instanceof EditScopeDeniedError
      ? error
      : error instanceof AgentPartialCompletionError &&
          error.completedMutationCount === 0 &&
          error.cause instanceof EditScopeDeniedError
        ? error.cause
        : undefined;
    if (scopeDenial) {
      if (operationId && !applyResultRecorded) await recordApplyResult(scopeDenial.message, options.signal?.aborted ? "cancelled" : "failed");
      throwIfAborted(options.signal);
      const content = `${scopeDenial.message}\nNo Live changes from this plan were applied.`;
      if (!applyResultRecorded) await emitTraceEvent(options, {
        kind: "tool_result", outcome: "failed",
        name: toolCall.name,
        content,
      });
      return {
        toolContent: content,
        userMessage: content,
        cancelled: false,
        failed: true,
        mutationProgress: false,
        failureKind: "host",
      };
    }
    if (error instanceof AgentRecoveryResolutionSteeringError) {
      await emitTraceEvent(options, {
        kind: "tool_result", outcome: "stopped",
        name: toolCall.name,
        content: error.message,
      });
      return {
        toolContent: error.message,
        userMessage: error.message,
        cancelled: false,
        failed: false,
        mutationProgress: false,
      };
    }
    if (error instanceof AgentSteeringBeforeApplyError) {
      if (!applyResultRecorded) await recordApplyResult(error.message, "cancelled");
      return {
        toolContent: error.message,
        userMessage: error.message,
        cancelled: false,
        failed: false,
        mutationProgress: false,
      };
    }
    if (error instanceof AgentPartialCompletionError) {
      const failureContent = error.message;
      recoveryState.unresolvedFailure = failureContent;
      recoveryState.requiresExplicitResolution ||=
        error.completedMutationCount > 0;
      const failedPlan = applyPlan ?? actionPlanFromToolCall(toolCall);
      if (
        !Number.isInteger(error.completedActionCount) ||
        error.completedActionCount < 0 ||
        error.completedActionCount > failedPlan.actions.length
      ) {
        throw new Error("Live action execution returned an invalid completed-action count.");
      }
      for (const action of failedPlan.actions.slice(0, error.completedActionCount)) {
        rememberCompletedActionIdentity(recoveryState, agentActionKey(action));
      }
      const semanticKeys = error.completedActionKeys.length
        ? error.completedActionKeys
        : (applyActionKeys ?? []).slice(0, error.completedActionCount);
      for (const keys of semanticKeys) {
        for (const key of keys) rememberCompletedActionIdentity(recoveryState, key);
      }
      try {
        const recoveryUpdate = recoveryState.requiresExplicitResolution
          ? recoveryLedgerUpdate(recoveryState)
          : undefined;
        await recordApplyResult(failureContent, error.completedMutationCount > 0 ? "partial" : options.signal?.aborted ? "cancelled" : "failed", recoveryUpdate);
      } catch (reportingError) {
        throw new AgentApplyResultReportingError(
          error.completedResults,
          reportingError,
        );
      }
      throwIfAborted(options.signal);
      const requiredObservation = recoveryRequestForFailure(error);
      recoveryState.requiredObservation = requiredObservation;
      recoveryState.requiresLiveSetObservationForResolution = false;
      let recoveryObservation = "";
      let recoveryObservationAvailable = false;
      try {
        const observed = await options.observe(requiredObservation);
        recoveryObservation = typeof observed === "string"
          ? observed
          : observed.content;
        throwIfAborted(options.signal);
        recoveryState.requiredObservation = undefined;
        recoveryObservationAvailable = true;
      } catch (observationError) {
        throwIfAborted(options.signal);
        recoveryObservation = `Automatic Live state refresh was unavailable: ${errorMessage(observationError)}`;
      }
      const content = [
        failureContent,
        "Current Live state after the failure:",
        recoveryObservation,
        error.cause instanceof EditScopeDeniedError
          ? "The Session's edit scope blocked the next action. Keep completed work and do not retry forbidden edits. Only the user can expand Edit Scope; continue within the currently allowed scopes."
          : recoveryObservationAvailable
          ? "Use this refreshed state or inspect a narrower target, keep every completed action, and continue only with missing work. The beta SDK did not identify the failure cause; do not infer that the device name is unavailable. Repair only what the observed state supports."
          : "Inspect the affected Live object successfully before applying anything else. Keep every completed action and continue only with missing work. The beta SDK did not identify the failure cause; do not infer that the device name is unavailable.",
      ].join("\n");
      return {
        toolContent: content,
        userMessage: content,
        cancelled: false,
        failed: true,
        mutationProgress: error.completedMutationCount > 0,
        ...(recoveryObservationAvailable
          ? { progressKey: recoveryProgressKey(error, requiredObservation) }
          : {}),
        failureKind: "host",
      };
    }
    if (error instanceof AgentRecoveryPlanError) {
      const content = error.message;
      await emitTraceEvent(options, {
        kind: "tool_result", outcome: "failed",
        name: toolCall.name,
        content,
      });
      return {
        toolContent: content,
        userMessage: content,
        cancelled: false,
        failed: true,
        mutationProgress: false,
        failureKind: "host",
      };
    }
    if (error instanceof AgentToolArgumentsError) {
      throwIfAborted(options.signal);
      const content = [
        `Tool call "${toolCall.name}" has invalid arguments: ${error.message}`,
        "Correct the tool fields and types, then retry. Do not change the musical request or split valid work solely because of this argument error.",
      ].join("\n");
      await emitTraceEvent(options, {
        kind: "tool_result", outcome: "failed",
        name: toolCall.name,
        content,
      });
      return {
        toolContent: content,
        userMessage: content,
        cancelled: false,
        failed: true,
        mutationProgress: false,
        failureKind: "arguments",
      };
    }
    if (error instanceof AgentObservationError) {
      throwIfAborted(options.signal);
      const content = [
        `Live observation "${error.request.type}" failed: ${error.message}`,
        "The tool arguments were accepted. Reinspect the current object or a narrower target; do not infer missing Live state and do not split the requested edit solely because of this observation failure.",
      ].join("\n");
      await emitTraceEvent(options, { kind: "error", content });
      return {
        toolContent: content,
        userMessage: content,
        cancelled: false,
        failed: true,
        mutationProgress: false,
        failureKind: "observation",
      };
    }
    if (
      error instanceof AgentExternalToolReportingError ||
      (error instanceof AgentActionPreflightError && !error.recoverable) ||
      error instanceof AgentApplyResultReportingError ||
      error instanceof AgentRecoveryResolutionReportingError
    ) {
      throw error;
    }
    if (error instanceof AgentActionPreflightError) {
      throwIfAborted(options.signal);
      const content = [
        `Live Smith could not verify current Live state for this action plan: ${error.message}`,
        "This is a Live-state preflight failure, not evidence that the JSON arguments are invalid or that the payload is too large. Inspect the relevant Live object and repair its target or state assumptions. Do not split or simplify the requested work solely because of this error.",
      ].join("\n");
      if (!applyResultRecorded) await emitTraceEvent(options, { kind: "error", content });
      return {
        toolContent: content,
        userMessage: content,
        cancelled: false,
        failed: true,
        mutationProgress: false,
        failureKind: "host",
      };
    }
    throwIfAborted(options.signal);
    const message = errorMessage(error);
    const content = [
      `Tool call "${toolCall.name}" failed: ${message}`,
      "The failure category is unknown. Preserve completed actions, inspect relevant Live state when possible, and retry only a repair supported by evidence.",
    ].join("\n");
    if (!applyResultRecorded) await emitTraceEvent(options, { kind: "error", content });
    return {
      toolContent: content,
      userMessage: content,
      cancelled: false,
      failed: true,
      mutationProgress: false,
      failureKind: "internal",
    };
  }
}

function recoveryRequestForFailure(
  error: AgentPartialCompletionError,
): AgentObservationRequest {
  const action = error.failedAction;
  if (!action) return { type: "inspect_live_set" };
  if (error.failedTrackSelector === null) return { type: "inspect_live_set" };
  return observationRequestForAction(
    action,
    error.failedTrackSelector ?? error.failedTrackName,
  );
}

function recoveryProgressKey(
  error: AgentPartialCompletionError,
  request: AgentObservationRequest,
): string {
  return `automatic-recovery:${JSON.stringify({
    request,
    failedActionIndex: error.failedActionIndex,
    failedAction: error.failedAction,
    completedActionKeys: error.completedActionKeys,
    completedMutationCount: error.completedMutationCount,
    completedActionCount: error.completedActionCount,
    cause: errorMessage(error.cause),
  })}`;
}

function agentActionKey(action: AgentAction): string {
  return JSON.stringify(action);
}

export function digestActionIdentity(identity: string): string {
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

function hasCompletedActionIdentity(
  recoveryState: AgentRecoveryState,
  identity: string,
): boolean {
  return recoveryState.completedActionDigests.has(digestActionIdentity(identity));
}

function rememberCompletedActionIdentity(
  recoveryState: AgentRecoveryState,
  identity: string,
): void {
  recoveryState.completedActionDigests.add(digestActionIdentity(identity));
}

function assertRecoveryLedgerHasCapacity(
  recoveryState: AgentRecoveryState,
  plan: AgentPlan,
  actionKeys: readonly (readonly string[])[] | undefined,
): void {
  if (
    recoveryState.unresolvedFailure === undefined ||
    !recoveryState.requiresExplicitResolution
  ) return;
  const additionalDigests = new Set<string>();
  for (const [index, action] of plan.actions.entries()) {
    additionalDigests.add(digestActionIdentity(agentActionKey(action)));
    for (const key of actionKeys?.[index] ?? []) {
      additionalDigests.add(digestActionIdentity(key));
    }
  }
  for (const digest of recoveryState.completedActionDigests) {
    additionalDigests.delete(digest);
  }
  const limit = plan.resolvesPriorFailure === true
    ? MAX_FINAL_RECOVERY_ADMISSION_DIGESTS
    : MAX_STAGED_RECOVERY_ACTION_DIGESTS;
  if (recoveryState.completedActionDigests.size + additionalDigests.size <= limit) {
    return;
  }
  throw new AgentRecoveryPlanError(
    plan.resolvesPriorFailure === true
      ? "The final recovery Apply is too large for the bounded replay ledger. Split the remaining repair into fewer actions, or inspect the current Live Set and use resolve_live_recovery so the user can keep completed changes and close the unfinished operation."
      : "The bounded replay ledger is reserving space for the final repair. Finish the current unfinished operation with resolvesPriorFailure, or inspect the current Live Set and use resolve_live_recovery so the user can close it before starting more Live work.",
  );
}

function recoveryLedgerUpdate(
  recoveryState: AgentRecoveryState,
): AgentRecoveryLedgerUpdate {
  return {
    active: true,
    completedActionDigests: [...recoveryState.completedActionDigests].sort(),
  };
}

function observationCoversRecovery(
  actual: AgentObservationRequest,
  required: AgentObservationRequest,
): boolean {
  if (actual.type !== required.type) return false;
  switch (required.type) {
    case "inspect_live_set":
    case "inspect_current_object":
      return true;
    case "read_arrangement_audio":
      return false;
    case "inspect_song_info":
      return actual.type === "inspect_song_info" && (
        required.itemOffset === undefined ||
        (actual.itemOffset ?? 0) === required.itemOffset
      );
    case "inspect_track":
      return actual.type === "inspect_track" &&
        trackSelectorMatches(actual, required);
    case "inspect_take_lane":
      return actual.type === "inspect_take_lane" &&
        optionalTextMatches(actual.trackName, required.trackName) &&
        actual.laneIndex === required.laneIndex &&
        (required.laneName === undefined ||
          optionalTextMatches(actual.laneName, required.laneName));
    case "inspect_device":
      return actual.type === "inspect_device" &&
        trackSelectorMatches(actual, required) &&
        normalizedText(actual.deviceName) === normalizedText(required.deviceName) &&
        actual.deviceIndex === required.deviceIndex;
    case "inspect_device_tree":
      return actual.type === "inspect_device_tree" &&
        trackSelectorMatches(actual, required) &&
        optionalTextMatches(actual.deviceName, required.deviceName) &&
        JSON.stringify(actual.devicePath) === JSON.stringify(required.devicePath);
    case "inspect_rack_chain":
      return actual.type === "inspect_rack_chain" &&
        trackSelectorMatches(actual, required) &&
        normalizedText(actual.rackName) === normalizedText(required.rackName) &&
        JSON.stringify(actual.rackPath) === JSON.stringify(required.rackPath) &&
        actual.chainIndex === required.chainIndex &&
        (required.itemOffset === undefined ||
          (actual.itemOffset ?? 0) === required.itemOffset);
    case "inspect_mixer":
      return actual.type === "inspect_mixer" &&
        trackSelectorMatches(actual, required);
    case "inspect_clip":
      return actual.type === "inspect_clip" &&
        optionalTextMatches(actual.trackName, required.trackName) &&
        optionalTextMatches(actual.clipName, required.clipName) &&
        actual.startBeat === required.startBeat &&
        actual.slotIndex === required.slotIndex;
    case "inspect_midi_clip":
      return actual.type === "inspect_midi_clip" &&
        optionalTextMatches(actual.trackName, required.trackName) &&
        optionalTextMatches(actual.clipName, required.clipName) &&
        actual.startBeat === required.startBeat &&
        actual.slotIndex === required.slotIndex;
    case "analyze_audio_clip":
      return actual.type === "analyze_audio_clip" &&
        optionalTextMatches(actual.trackName, required.trackName) &&
        optionalTextMatches(actual.clipName, required.clipName) &&
        actual.startBeat === required.startBeat;
  }
}

function trackSelectorMatches(
  actual: { trackName?: string; trackRole?: "return" | "main"; trackIndex?: number },
  required: { trackName?: string; trackRole?: "return" | "main"; trackIndex?: number },
): boolean {
  return optionalTextMatches(actual.trackName, required.trackName) &&
    actual.trackRole === required.trackRole &&
    actual.trackIndex === required.trackIndex;
}

function optionalTextMatches(actual?: string, required?: string): boolean {
  return required === undefined
    ? actual === undefined
    : actual !== undefined && normalizedText(actual) === normalizedText(required);
}

function normalizedText(value: string): string {
  return value.trim().toLowerCase();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function emitTraceEvent(
  options: AgentToolExecutionOptions<unknown>,
  event: AgentLoopTraceEvent,
): Promise<void> {
  await options.onEvent?.(event);
}
