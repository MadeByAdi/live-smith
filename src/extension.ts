import {
  initialize,
  type ActivationContext,
  type ArrangementSelection,
  type ClipSlotSelection,
  type ExtensionContext,
  type Handle,
} from "@ableton-extensions/sdk";

import { runAgentFlow, showAgentError } from "./app/agent-flow.js";
import { LiveMutationQueue } from "./app/live-mutation-queue.js";
import {
  arrangementSelectionInteractionContext,
  clipSlotSelectionInteractionContext,
  objectInteractionContext,
} from "./live/context.js";
import { openOAuthAuthorizationUrl } from "./runtime/oauth-browser.js";
import { createSmithCompanionOpener } from "./runtime/smith-companion.js";

type Api = ExtensionContext<"1.0.0">;

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");
  const liveMutationQueue = new LiveMutationQueue();
  const openNonBlockingChat = createSmithCompanionOpener();

  context.commands.registerCommand("live-smith.ask-object", (arg: unknown) => {
    void askAboutObject(context, arg as Handle, liveMutationQueue, openNonBlockingChat).catch((error) =>
      showAgentError(context, error),
    );
  });

  context.commands.registerCommand(
    "live-smith.ask-arrangement-selection",
    (arg: unknown) => {
      void askAboutArrangementSelection(
        context,
        arg as ArrangementSelection,
        liveMutationQueue,
        openNonBlockingChat,
      ).catch(
        (error) => showAgentError(context, error),
      );
    },
  );

  context.commands.registerCommand(
    "live-smith.ask-clip-slot-selection",
    (arg: unknown) => {
      void askAboutClipSlotSelection(
        context,
        arg as ClipSlotSelection,
        liveMutationQueue,
        openNonBlockingChat,
      ).catch(
        (error) => showAgentError(context, error),
      );
    },
  );

  for (const scope of [
    "AudioClip",
    "MidiClip",
    "AudioTrack",
    "MidiTrack",
    "ClipSlot",
    "Scene",
    "Simpler",
    "Sample",
    "DrumRack",
  ] as const) {
    void context.ui.registerContextMenuAction(
      scope,
      "Ask Live Smith",
      "live-smith.ask-object",
    );
  }

  void context.ui.registerContextMenuAction(
    "AudioTrack.ArrangementSelection",
    "Ask Live Smith about selection",
    "live-smith.ask-arrangement-selection",
  );
  void context.ui.registerContextMenuAction(
    "MidiTrack.ArrangementSelection",
    "Ask Live Smith about selection",
    "live-smith.ask-arrangement-selection",
  );
  void context.ui.registerContextMenuAction(
    "ClipSlotSelection",
    "Ask Live Smith about selected slots",
    "live-smith.ask-clip-slot-selection",
  );
}

async function askAboutObject(
  context: Api,
  handle: Handle,
  liveMutationQueue: LiveMutationQueue,
  openNonBlockingChat: ReturnType<typeof createSmithCompanionOpener>,
): Promise<void> {
  await runAgentFlow(
    context,
    objectInteractionContext(context, handle),
    { liveMutationQueue, openOAuthAuthorizationUrl, openNonBlockingChat },
  );
}

async function askAboutArrangementSelection(
  context: Api,
  selection: ArrangementSelection,
  liveMutationQueue: LiveMutationQueue,
  openNonBlockingChat: ReturnType<typeof createSmithCompanionOpener>,
): Promise<void> {
  await runAgentFlow(
    context,
    arrangementSelectionInteractionContext(context, selection),
    { liveMutationQueue, openOAuthAuthorizationUrl, openNonBlockingChat },
  );
}

async function askAboutClipSlotSelection(
  context: Api,
  selection: ClipSlotSelection,
  liveMutationQueue: LiveMutationQueue,
  openNonBlockingChat: ReturnType<typeof createSmithCompanionOpener>,
): Promise<void> {
  await runAgentFlow(
    context,
    clipSlotSelectionInteractionContext(context, selection),
    { liveMutationQueue, openOAuthAuthorizationUrl, openNonBlockingChat },
  );
}
