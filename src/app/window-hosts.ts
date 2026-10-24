import type { ExtensionContext } from "@ableton-extensions/sdk";
import type { LiveInteractionContext } from "../live/context.js";
import { createLiveSetGuard } from "../live/set-identity.js";
import { loadAgentSettings } from "../storage/settings.js";
import { createSystemBrowserOpener } from "../runtime/system-browser.js";
import { projectKeyForContext } from "./context/session-context.js";
import { setInteractionContext } from "../live/context.js";
import { createAgentRuntime, runAgentFlow, type AgentFlowDependencies, type AgentRuntime } from "./agent-flow.js";

type Api = ExtensionContext<"1.0.0">;
type WindowDependencies = AgentFlowDependencies & {
  openBrowser?: (url: string) => Promise<void>;
  openVst3?: (url: string) => Promise<void>;
};

/** One activation owns one browser runtime; invocation changes are serialized. */
export function createWindowHostController(context: Api, dependencies: WindowDependencies = {}) {
  const openBrowser = dependencies.openBrowser ?? createSystemBrowserOpener({ allowLoopbackHttp: true });
  let browser: { key: string; projectKey: string; runtime: AgentRuntime } | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);
    tail = result.catch(() => {});
    return result;
  };
  const closeBrowser = async () => {
    const previous = browser;
    browser = undefined;
    await previous?.runtime.close();
  };
  return {
    async start(): Promise<void> {
      if (!dependencies.openVst3) throw new Error("The VST3 handoff is unavailable.");
      await serialize(async () => {
        const assertLiveSetCurrent = createLiveSetGuard(context);
        const projectKey = projectKeyForContext(context);
        if (browser?.projectKey === projectKey) return;
        if (browser?.runtime.busy) throw new Error("Live Smith is still working in the previous Set.");
        if (browser) await closeBrowser();
        assertLiveSetCurrent();
        const interaction = setInteractionContext(context);
        const runtime = await createAgentRuntime(context, interaction, dependencies, "browser");
        try {
          await dependencies.openVst3!(runtime.browserUrl);
          assertLiveSetCurrent();
          browser = { key: JSON.stringify([projectKey, interaction.scope.kind, interaction.scope.identity, null]), projectKey, runtime };
        } catch (error) {
          await runtime.close();
          throw error;
        }
      });
    },
    async open(interaction: LiveInteractionContext): Promise<void> {
      const assertLiveSetCurrent = createLiveSetGuard(context);
      const projectKey = projectKeyForContext(context);
      // A modal owns its own lifetime, independent of a browser's admitted work.
      const mode = (await loadAgentSettings(context.environment.storageDirectory)).interfaceMode;
      if (mode === "modal" && !dependencies.openVst3) {
        await serialize(async () => {
          assertLiveSetCurrent();
          if (browser && !browser.runtime.busy) await closeBrowser();
        });
        assertLiveSetCurrent();
        await runAgentFlow(context, interaction, dependencies);
        return;
      }
      await serialize(async () => {
        assertLiveSetCurrent();
        const key = JSON.stringify([projectKey, interaction.scope.kind, interaction.scope.identity,
          interaction.selectionContext?.identity ?? null]);
        let adopted = false;
        if (browser && browser.projectKey !== projectKey) await closeBrowser();
        if (browser && browser.key !== key) {
          if (browser.runtime.busy) throw new Error("Live Smith is still working in the browser. Return to that tab and finish or Stop the current operation before asking about another selection.");
          browser.runtime.adopt(interaction);
          browser.key = key;
          adopted = true;
        }
        assertLiveSetCurrent();
        const reused = browser !== undefined;
        if (!browser) browser = { key, projectKey, runtime: await createAgentRuntime(context, interaction, dependencies, "browser") };
        if (reused && !adopted) await browser.runtime.reopen();
        try {
          if (dependencies.openVst3) await dependencies.openVst3(browser.runtime.browserUrl);
          else await openBrowser(browser.runtime.url);
        }
        catch {
          if (!reused) await closeBrowser();
          throw new Error("Live Smith could not open the system browser. Check your default browser and try Ask Live Smith again.");
        }
      });
    },
    close: () => serialize(closeBrowser),
  };
}
