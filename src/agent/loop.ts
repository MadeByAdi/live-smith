import { normalizeModelCitations } from "../model/citations.js";
import { requireModelContextUsage,type ModelCitation,type ModelContextUsage,type ModelConversationMessage,type ModelHostedWebSearch,type ModelReasoning,type ModelToolCall,type ModelTurn } from "../model/contracts.js";
import { mergeModelReasoning,requireModelReasoning } from "../model/reasoning.js";
import { HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND } from "../model/tools.js";
import { isModelHostedWebSearch } from "../model/web-search.js";
import { throwIfAborted } from "../runtime/host.js";
import {
createAgentRecoveryState,
emitTraceEvent,
executeAgentTool,
type AgentLoopInitialRecoveryState,
type AgentToolExecutionOptions
} from "./tool-execution.js";
export * from "./tool-execution.js";

export interface AgentLoopModelInput {
  messages: ModelConversationMessage[];
  iteration: number;
  /** True only while replaying an output-limit continuation chain. */
  continuation: boolean;
}

export interface AgentLoopResult {
  message: string;
}

export interface AgentLoopOptions<ExecutionBindings = undefined> extends AgentToolExecutionOptions<ExecutionBindings> {
  maxConsecutiveFailures: number;
  maxIterations?: number;
  maxToolCallsPerTurn?: number;
  maxModelContinuations?: number;
  maxHostFailuresWithoutMutation?: number;
  initialRecoveryState?: AgentLoopInitialRecoveryState;
  consumeSteering?(): Promise<readonly Extract<ModelConversationMessage, { role: "user" }>[]>;
  onSteeringApplied?(messageCount: number): Promise<void> | void;
  onModelTurnAccepted?(usage: ModelContextUsage | undefined): Promise<void> | void;
  askModel(input: AgentLoopModelInput): Promise<ModelTurn>;
}

export class AgentSteeringInterruptError extends Error {
  constructor() {
    super("The current model turn was interrupted by newer user guidance.");
    this.name = "AgentSteeringInterruptError";
  }
}

export async function runAgentLoop(
  options: AgentLoopOptions<unknown>,
): Promise<AgentLoopResult> {
  if (options.admittedToolNames) options = { ...options, admittedToolNames: [...options.admittedToolNames] };
  const messages: ModelConversationMessage[] = [];
  const maxIterations = options.maxIterations ?? 12;
  const maxToolCallsPerTurn = options.maxToolCallsPerTurn ?? 32;
  const maxModelContinuations = options.maxModelContinuations ?? 2;
  const maxHostFailuresWithoutMutation =
    options.maxHostFailuresWithoutMutation ?? 6;
  let lastMessage = "";
  let repeatedArgumentFailures = 0;
  let lastArgumentFailure = "";
  let hostFailuresWithoutMutation = 0;
  let planningProgressDeadline = maxIterations;
  let consecutiveModelContinuations = 0;
  let pendingContinuationContent = "";
  let pendingContinuationReasoning: ModelReasoning | undefined;
  let pendingContinuationCitations: ModelCitation[] = [];
  let pendingContinuationMessageStart: number | undefined;
  const observedProgress = new Set<string>();
  const recoveryState = createAgentRecoveryState(options.initialRecoveryState);
  const appendSteering = (beforeAppend?: () => void) => appendPendingSteering(
    options,
    messages,
    () => {
      if (pendingContinuationMessageStart !== undefined) {
        messages.splice(pendingContinuationMessageStart);
        pendingContinuationMessageStart = undefined;
      }
      beforeAppend?.();
    },
  );

  planningLoop:
  for (let iteration = 1; ; iteration += 1) {
    throwIfAborted(options.signal);
    if (await appendSteering()) {
      planningProgressDeadline = iteration + maxIterations;
      repeatedArgumentFailures = 0;
      lastArgumentFailure = "";
      consecutiveModelContinuations = 0;
      pendingContinuationContent = "";
      pendingContinuationReasoning = undefined;
      pendingContinuationCitations = [];
    }
    if (iteration > planningProgressDeadline) {
      return stopAtSafetyLimit(
        options,
        `Stopped after ${maxIterations} planning steps without new Live information or a completed Live mutation. Continue in this Session with the unfinished stage or inspect the latest error.`,
      );
    }

    await options.onProgress?.(`Planning step ${iteration}`);
    throwIfAborted(options.signal);

    let turn: ModelTurn;
    try {
      turn = await options.askModel({
        messages: [...messages],
        iteration,
        continuation: consecutiveModelContinuations > 0,
      });
    } catch (error) {
      if (!(error instanceof AgentSteeringInterruptError)) throw error;
      throwIfAborted(options.signal);
      const hadPendingSteering = options.hasPendingSteering?.();
      const installedSteeringCount = await appendSteering();
      if (!installedSteeringCount && hadPendingSteering !== true) {
        throw new Error(
          "A model turn reported a steering interruption without any pending user guidance.",
          { cause: error },
        );
      }
      if (installedSteeringCount) {
        planningProgressDeadline = iteration + maxIterations;
        repeatedArgumentFailures = 0;
        lastArgumentFailure = "";
        consecutiveModelContinuations = 0;
        pendingContinuationContent = "";
        pendingContinuationReasoning = undefined;
        pendingContinuationCitations = [];
      }
      continue;
    }
    throwIfAborted(options.signal);

    if (await appendSteering()) {
      planningProgressDeadline = iteration + maxIterations;
      repeatedArgumentFailures = 0;
      lastArgumentFailure = "";
      consecutiveModelContinuations = 0;
      pendingContinuationContent = "";
      pendingContinuationReasoning = undefined;
      pendingContinuationCitations = [];
      continue;
    }

    const turnReasoning = requireModelReasoning(turn.reasoning);

    const assistantMessageIndex = messages.length;
    messages.push({
      role: "assistant",
      content: turn.content,
      toolCalls: turn.toolCalls,
      ...(turn.providerState !== undefined
        ? { providerState: turn.providerState }
        : {}),
      ...(turn.contextProjection ? { contextProjection: turn.contextProjection } : {}),
    });

    if (turn.hostedWebSearches !== undefined) {
      const visibleSearches = Array.isArray(turn.hostedWebSearches)
        ? turn.hostedWebSearches.slice(0, HOSTED_WEB_SEARCH_MAX_EVENTS_PER_SEND)
        : [];
      if (
        !Array.isArray(turn.hostedWebSearches) ||
        new Set(visibleSearches.map((search) => search.id)).size !==
          visibleSearches.length ||
        visibleSearches.some((search) =>
          search.status === "searching" || !isModelHostedWebSearch(search)
        )
      ) {
        throw new TypeError("Hosted Web Search activity is invalid.");
      }
      for (const search of visibleSearches) {
        await emitTraceEvent(options, {
          kind: "web_search",
          content: webSearchSummary(search),
          webSearch: search,
        });
      }
    }

    if (turn.continuation) {
      if (
        (turn.continuation.reason !== "output_limit" && turn.continuation.reason !== "hosted_tools") ||
        turn.termination !== undefined ||
        turn.toolCalls.length !== 0 ||
        turn.providerState === undefined
      ) {
        throw new TypeError("Model continuation state is invalid.");
      }
    }
    if (turn.continuation?.reason === "output_limit") {
      pendingContinuationMessageStart ??= assistantMessageIndex;
      consecutiveModelContinuations += 1;
      pendingContinuationContent += turn.content ?? "";
      pendingContinuationReasoning = mergeModelReasoning([
        pendingContinuationReasoning,
        turnReasoning,
      ]);
      pendingContinuationCitations = mergeCitations(
        pendingContinuationCitations,
        turn.citations ?? [],
      );
      if (consecutiveModelContinuations > maxModelContinuations) {
        const partialText = pendingContinuationContent.trim();
        if (pendingContinuationReasoning) {
          await emitTraceEvent(options, {
            kind: "reasoning",
            content: pendingContinuationReasoning.content,
          });
        }
        if (partialText) {
          await emitTraceEvent(options, {
            kind: "assistant",
            content: partialText,
            ...(pendingContinuationCitations.length
              ? { citations: pendingContinuationCitations }
              : {}),
          });
        }
        const stopMessage =
          `Stopped after ${maxModelContinuations} automatic continuation attempts because the model repeatedly reached its output-token limit. No incomplete tool call was executed. Increase this Profile's Max Output Tokens or continue in this Session.`;
        const terminalMessage = recoveryState.unresolvedFailure
          ? `${stopMessage}\n\n${unfinishedWorkMessage(
              recoveryState.unresolvedFailure,
              Boolean(partialText),
            )}`
          : stopMessage;
        await emitTraceEvent(options, { kind: "error", content: terminalMessage });
        return {
          message: [partialText, terminalMessage].filter(Boolean).join("\n\n"),
        };
      }
      planningProgressDeadline += 1;
      await options.onProgress?.(
        `Continuing model response after output limit (${consecutiveModelContinuations}/${maxModelContinuations})`,
      );
      continue;
    }

    if (
      turn.termination !== undefined &&
      (
        (turn.termination.reason !== "context_limit" &&
          turn.termination.reason !== "output_limit") ||
        turn.toolCalls.length !== 0
      )
    ) {
      throw new TypeError("Model termination state is invalid.");
    }

    const acceptedContextUsage = turn.contextUsage === undefined
      ? undefined
      : requireModelContextUsage(
          turn.contextUsage.usedTokens,
          turn.contextUsage.contextWindowTokens,
        );
    await options.onModelTurnAccepted?.(acceptedContextUsage);

    const completedTurnContent = pendingContinuationContent + (turn.content ?? "");
    const completedTurnReasoning = mergeModelReasoning([
      pendingContinuationReasoning,
      turnReasoning,
    ]);
    const completedTurnCitations = mergeCitations(
      pendingContinuationCitations,
      turn.citations ?? [],
    );
    consecutiveModelContinuations = 0;
    pendingContinuationContent = "";
    pendingContinuationReasoning = undefined;
    pendingContinuationCitations = [];
    pendingContinuationMessageStart = undefined;

    if (completedTurnReasoning) {
      await emitTraceEvent(options, {
        kind: "reasoning",
        content: completedTurnReasoning.content,
      });
    }

    if (turn.termination) {
      const partialText = completedTurnContent.trim();
      if (partialText) {
        await emitTraceEvent(options, {
          kind: "assistant",
          content: partialText,
          ...(completedTurnCitations.length
            ? { citations: completedTurnCitations }
            : {}),
        });
      }
      const stopMessage = turn.termination.reason === "context_limit"
        ? "The model stopped because this Session reached its context-window limit. Configure an accurate Context Window and Compact At threshold for this model, or start a new Session before continuing."
        : "The model stopped at its output-token limit while a provider-hosted tool was still unfinished. No incomplete tool call was executed. Increase this Profile's Max Output Tokens and try again.";
      const terminalMessage = recoveryState.unresolvedFailure
        ? `${stopMessage}\n\n${unfinishedWorkMessage(
            recoveryState.unresolvedFailure,
            Boolean(partialText),
          )}`
        : stopMessage;
      await emitTraceEvent(options, { kind: "error", content: terminalMessage });
      return {
        message: [partialText, terminalMessage].filter(Boolean).join("\n\n"),
      };
    }

    if (!turn.toolCalls.length && !turn.continuation) {
      const finalText = completedTurnContent.trim();
      if (recoveryState.unresolvedFailure) {
        if (finalText) {
          await emitTraceEvent(options, {
            kind: "assistant",
            content: finalText,
            ...(completedTurnCitations.length ? { citations: completedTurnCitations } : {}),
          });
        }
        if (await appendSteering()) {
          planningProgressDeadline = iteration + maxIterations;
          continue;
        }
        const message = unfinishedWorkMessage(
          recoveryState.unresolvedFailure,
          Boolean(finalText),
        );
        await emitTraceEvent(options, { kind: "error", content: message });
        return { message };
      }
      if (!finalText) {
        throw new Error("The model returned an empty response.");
      }
      lastMessage = finalText;
      await emitTraceEvent(options, {
        kind: "assistant",
        content: lastMessage,
        ...(completedTurnCitations.length ? { citations: completedTurnCitations } : {}),
      });
      if (await appendSteering()) {
        planningProgressDeadline = iteration + maxIterations;
        continue;
      }
      return { message: lastMessage };
    }

    if (completedTurnContent.trim()) {
      lastMessage = completedTurnContent.trim();
      await emitTraceEvent(options, {
        kind: "assistant",
        content: lastMessage,
        ...(completedTurnCitations.length ? { citations: completedTurnCitations } : {}),
      });
    }

    if (turn.toolCalls.length > maxToolCallsPerTurn) {
      const content = `This model turn returned ${turn.toolCalls.length} tool calls, exceeding the per-turn safety limit of ${maxToolCallsPerTurn}. None were executed. Regroup the same unfinished stage into fewer tool calls; completed Live work is preserved.`;
      answerToolCallsWithoutExecution(messages, turn.toolCalls, content);
      await emitTraceEvent(options, { kind: "error", content });
      if (content === lastArgumentFailure) repeatedArgumentFailures += 1;
      else {
        lastArgumentFailure = content;
        repeatedArgumentFailures = 1;
      }
      if (repeatedArgumentFailures >= options.maxConsecutiveFailures) {
        return {
          message: [
            content,
            "",
            `Stopped after the same invalid tool-call batch repeated ${repeatedArgumentFailures} times.`,
          ].join("\n"),
        };
      }
      continue;
    }

    for (const [toolCallIndex, toolCall] of turn.toolCalls.entries()) {
      throwIfAborted(options.signal);
      if (options.hasPendingSteering?.()) {
        if (await appendSteering(() => skipRemainingToolCalls(
          messages,
          turn.toolCalls,
          toolCallIndex,
          "not executed because a newer user steering message superseded this tool batch",
        ))) {
          planningProgressDeadline = iteration + maxIterations;
          repeatedArgumentFailures = 0;
          lastArgumentFailure = "";
          continue planningLoop;
        }
      }
      const result = await executeAgentTool(options, toolCall, recoveryState);
      throwIfAborted(options.signal);
      messages.push({
        role: "tool",
        toolCallId: toolCall.id,
        content: result.toolContent,
        ...(result.modelInputPart
          ? { modelInputPart: result.modelInputPart }
          : {}),
      });

      // New guidance cannot reopen a paid operation whose outcome is unknown.
      // Leave unconsumed steering with its owner instead of issuing another turn.
      if (result.cancelled && options.externalTools?.names.includes(toolCall.name)) {
        skipRemainingToolCalls(messages, turn.toolCalls, toolCallIndex + 1);
        return { message: result.userMessage };
      }

      if (options.hasPendingSteering?.()) {
        if (await appendSteering(() => skipRemainingToolCalls(
          messages,
          turn.toolCalls,
          toolCallIndex + 1,
          "not executed because a newer user steering message superseded this tool batch",
        ))) {
          planningProgressDeadline = iteration + maxIterations;
          repeatedArgumentFailures = 0;
          lastArgumentFailure = "";
          continue planningLoop;
        }
      }

      const newObservationProgress = result.progressKey !== undefined &&
        !observedProgress.has(result.progressKey);
      if (result.progressKey !== undefined) observedProgress.add(result.progressKey);
      if (result.mutationProgress || newObservationProgress) {
        planningProgressDeadline = iteration + maxIterations;
      }
      if (result.mutationProgress) {
        hostFailuresWithoutMutation = 0;
      } else if (result.failed && result.failureKind === "host") {
        hostFailuresWithoutMutation += 1;
      }

      if (result.cancelled) {
        skipRemainingToolCalls(messages, turn.toolCalls, toolCallIndex + 1);
        return {
          message: result.userMessage,
        };
      }

      if (result.failed) {
        // Every tool call in the turn needs a tool result message, even when we
        // stop early - otherwise the next model request is rejected for having
        // unanswered tool calls.
        skipRemainingToolCalls(messages, turn.toolCalls, toolCallIndex + 1);
        if (
          hostFailuresWithoutMutation >= maxHostFailuresWithoutMutation
        ) {
          const safetyMessage =
            `Stopped after ${hostFailuresWithoutMutation} host failures without a completed Live mutation. ` +
            "This bounds unproductive repair churn; it is not a total workflow or tool-call limit.";
          return stopAtSafetyLimit(
            options,
            recoveryState.unresolvedFailure
              ? `${safetyMessage}\n\n${unfinishedWorkMessage(recoveryState.unresolvedFailure)}`
              : safetyMessage,
          );
        }
        if (result.failureKind === "arguments") {
          if (result.toolContent === lastArgumentFailure) repeatedArgumentFailures += 1;
          else {
            lastArgumentFailure = result.toolContent;
            repeatedArgumentFailures = 1;
          }
        } else {
          repeatedArgumentFailures = 0;
          lastArgumentFailure = "";
        }
        if (repeatedArgumentFailures >= options.maxConsecutiveFailures) {
          const stopMessage =
            `Stopped after the same invalid tool error repeated ${repeatedArgumentFailures} times.`;
          await emitTraceEvent(options, { kind: "error", content: stopMessage });
          return {
            message: [
              result.userMessage,
              "",
              stopMessage,
            ].join("\n"),
          };
        }
        break;
      }

      repeatedArgumentFailures = 0;
      lastArgumentFailure = "";
    }
  }
}

function mergeCitations(
  first: readonly ModelCitation[],
  second: readonly ModelCitation[],
): ModelCitation[] {
  return normalizeModelCitations([...first, ...second]);
}

export function webSearchSummary(search: ModelHostedWebSearch): string {
  if (search.status === "failed") {
    return search.queries[0]
      ? `Web Search failed for “${search.queries[0]}”`
      : "Web Search failed";
  }
  const pages = search.sources.length;
  const firstQuery = search.queries[0];
  const action = search.action === "open_page"
    ? "Opened a web page"
    : search.action === "find_in_page"
      ? "Searched within a web page"
      : firstQuery
        ? `Searched for “${firstQuery}”${
          search.queries.length > 1 ? ` + ${search.queries.length - 1} more` : ""
        }`
        : "Searched the web";
  return [
    action,
    ...(pages > 0 ? [`${pages} ${pages === 1 ? "page" : "pages"}`] : []),
  ].join(" · ");
}

function unfinishedWorkMessage(
  failure: string,
  modelReturnedCompletion = false,
): string {
  return [
    "Live Smith stopped with unfinished Live work.",
    failure,
    modelReturnedCompletion
      ? "The model returned a completion response without resolving that Live failure."
      : "",
    "Continue in this Session to choose an available alternative or finish the remaining stage.",
  ].filter(Boolean).join("\n");
}

async function stopAtSafetyLimit(
  options: AgentLoopOptions<unknown>,
  message: string,
): Promise<AgentLoopResult> {
  await emitTraceEvent(options, { kind: "error", content: message });
  return { message };
}

function skipRemainingToolCalls(
  messages: ModelConversationMessage[],
  toolCalls: ModelToolCall[],
  startIndex: number,
  reason = "not executed because an earlier tool call in this turn did not complete",
): void {
  for (const toolCall of toolCalls.slice(startIndex)) {
    messages.push({
      role: "tool",
      toolCallId: toolCall.id,
      content: `Tool call "${toolCall.name}" was ${reason}.`,
    });
  }
}

async function appendPendingSteering(
  options: AgentLoopOptions<unknown>,
  messages: ModelConversationMessage[],
  beforeAppend?: () => void,
): Promise<number> {
  const steering = await options.consumeSteering?.() ?? [];
  for (const message of steering) {
    if (typeof message.content === "string"
      ? !message.content.trim()
      : !message.content.length) {
      throw new TypeError("A steering message must contain non-empty content.");
    }
  }
  if (steering.length) beforeAppend?.();
  messages.push(...steering);
  if (steering.length) {
    await options.onSteeringApplied?.(steering.length);
  }
  return steering.length;
}

function answerToolCallsWithoutExecution(
  messages: ModelConversationMessage[],
  toolCalls: ModelToolCall[],
  content: string,
): void {
  for (const toolCall of toolCalls) {
    messages.push({
      role: "tool",
      toolCallId: toolCall.id,
      content,
    });
  }
}
