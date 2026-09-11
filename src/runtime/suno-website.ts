import { createSystemBrowserOpener, type SystemBrowserOpenerOptions } from "./system-browser.js";

/** Opens the public website; it neither imports credentials nor observes sign-in. */
export function createSunoWebsiteOpener(options: SystemBrowserOpenerOptions = {}) {
  const open = createSystemBrowserOpener(options);
  return (signal?: AbortSignal): Promise<void> => open("https://suno.com/create", signal);
}

/** Opens the first-party API console in the user's default browser. */
export function createSunoPlatformOpener(options: SystemBrowserOpenerOptions = {}) {
  const open = createSystemBrowserOpener(options);
  return (signal?: AbortSignal): Promise<void> => open("https://platform.suno.com/", signal);
}

export const openSunoWebsite = createSunoWebsiteOpener();
export const openSunoPlatform = createSunoPlatformOpener();
