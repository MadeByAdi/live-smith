import { URL } from "node:url";
import { throwIfAborted } from "./host.js";
import { createSystemBrowserOpener, type SystemBrowserOpenerOptions } from "./system-browser.js";

const oauthAuthorizationHosts = new Set(["accounts.google.com", "auth.openai.com", "claude.ai"]);

export function createOAuthBrowserOpener(options: SystemBrowserOpenerOptions = {}) {
  const open = createSystemBrowserOpener(options);
  return async (target: string, signal?: AbortSignal): Promise<void> => {
    throwIfAborted(signal);
    let url: URL;
    try { url = new URL(target); }
    catch { throw new Error("OAuth requires a trusted HTTPS authorization URL."); }
    if (url.protocol !== "https:" || url.username || url.password || !oauthAuthorizationHosts.has(url.hostname)) {
      throw new Error("OAuth requires a trusted HTTPS authorization URL.");
    }
    await open(url.toString(), signal);
  };
}

export const openOAuthAuthorizationUrl = createOAuthBrowserOpener();
