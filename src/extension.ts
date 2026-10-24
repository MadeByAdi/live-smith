import { createWindowHostController } from "./app/window-hosts.js";
import { error as logError } from "node:console";
import {
  initialize,
  type ActivationContext,
  type ArrangementSelection,
  type ClipSlotSelection,
  type ExtensionContext,
  type Handle,
} from "@ableton-extensions/sdk";

import { showAgentError } from "./app/agent-flow.js";
import { ensureAgentAudioTapRegistryDirectory } from "./app/agent-audio-tap.js";
import { LiveMutationQueue } from "./app/live-mutation-queue.js";
import {
  arrangementSelectionInteractionContext,
  clipSlotSelectionInteractionContext,
  objectInteractionContext,
} from "./live/context.js";
import { openOAuthAuthorizationUrl } from "./runtime/oauth-browser.js";
import { openChatInVst3 } from "./runtime/vst3-handoff.js";
import { assertIsolatedNativeStorage, isolatedNativeBuild } from "./runtime/native-isolation.js";

type Api = ExtensionContext<"1.0.0">;

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");
  try {
    assertIsolatedNativeStorage(context.environment.storageDirectory);
  } catch {
    logError("Live Smith isolated native storage validation failed.");
    return;
  }
  void ensureAgentAudioTapRegistryDirectory();
  const windowHost = createWindowHostController(context, {
    liveMutationQueue: new LiveMutationQueue(), openOAuthAuthorizationUrl, openVst3: openChatInVst3,
  });
  void windowHost.start().catch(() => logError("Live Smith bridge startup failed."));

  const commandBase = isolatedNativeBuild ? "t7-live-smith-native-dev" : "live-smith";
  const actionLabel = isolatedNativeBuild ? "Ask T7 Live Smith Native Dev" : "Ask Live Smith";

  context.commands.registerCommand(`${commandBase}.ask-object`, (arg: unknown) => {
    void askAboutObject(context, arg as Handle, windowHost).catch((error) =>
      showAgentError(context, error),
    );
  });

  context.commands.registerCommand(
    `${commandBase}.ask-arrangement-selection`,
    (arg: unknown) => {
      void askAboutArrangementSelection(
        context,
        arg as ArrangementSelection,
        windowHost,
      ).catch(
        (error) => showAgentError(context, error),
      );
    },
  );

  context.commands.registerCommand(
    `${commandBase}.ask-clip-slot-selection`,
    (arg: unknown) => {
      void askAboutClipSlotSelection(
        context,
        arg as ClipSlotSelection,
        windowHost,
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
      actionLabel,
      `${commandBase}.ask-object`,
    );
  }

  void context.ui.registerContextMenuAction(
    "AudioTrack.ArrangementSelection",
    `${actionLabel} about selection`,
    `${commandBase}.ask-arrangement-selection`,
  );
  void context.ui.registerContextMenuAction(
    "MidiTrack.ArrangementSelection",
    `${actionLabel} about selection`,
    `${commandBase}.ask-arrangement-selection`,
  );
  void context.ui.registerContextMenuAction(
    "ClipSlotSelection",
    `${actionLabel} about selected slots`,
    `${commandBase}.ask-clip-slot-selection`,
  );
}

async function askAboutObject(
  context: Api,
  handle: Handle,
  windowHost: ReturnType<typeof createWindowHostController>,
): Promise<void> {
  await windowHost.open(
    objectInteractionContext(context, handle),
  );
}

async function askAboutArrangementSelection(
  context: Api,
  selection: ArrangementSelection,
  windowHost: ReturnType<typeof createWindowHostController>,
): Promise<void> {
  await windowHost.open(
    arrangementSelectionInteractionContext(context, selection),
  );
}

async function askAboutClipSlotSelection(
  context: Api,
  selection: ClipSlotSelection,
  windowHost: ReturnType<typeof createWindowHostController>,
): Promise<void> {
  await windowHost.open(
    clipSlotSelectionInteractionContext(context, selection),
  );
}
