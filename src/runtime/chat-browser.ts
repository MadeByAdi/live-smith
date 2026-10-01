import { URL } from "node:url";

import { throwIfAborted } from "./host.js";
import { createSystemBrowserOpener, type SystemBrowserOpenerOptions } from "./system-browser.js";

const launchTicket = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Opens the one-time, loopback-only ChatBridge browser entrypoint. */
export function createChatBrowserOpener(
  options: SystemBrowserOpenerOptions = {},
): (url: string, signal?: AbortSignal) => Promise<void> {
  const open = createSystemBrowserOpener({ ...options, allowLoopbackHttp: true });
  return async (value, signal) => {
    throwIfAborted(signal);
    assertChatBrowserLaunchUrl(value);
    await open(value, signal);
    throwIfAborted(signal);
  };
}

function assertChatBrowserLaunchUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new Error("Live Smith requires a valid local ChatBridge launch URL.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/chat" ||
    url.searchParams.size !== 1 ||
    !launchTicket.test(url.searchParams.get("launch") ?? "") ||
    url.username || url.password || url.hash
  ) {
    throw new Error("Live Smith requires a valid local ChatBridge launch URL.");
  }
}

export const openChatInSystemBrowser = createChatBrowserOpener();
