import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { URL } from "node:url";

import { throwIfAborted } from "./host.js";

const launchTicket = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const extensionDataDirectory = path.join(
  "Library",
  "Application Support",
  "Ableton",
  "Extensions Data",
  "sam-kuler.live-smith",
);

export interface Vst3HandoffOpenerOptions {
  homeDirectory?: string;
  mkdir?: typeof fs.mkdir;
  writeFile?: typeof fs.writeFile;
}

/** Writes the authenticated ChatBridge URL for the VST3 WebView host. */
export function createVst3HandoffOpener(
  options: Vst3HandoffOpenerOptions = {},
): (url: string, signal?: AbortSignal) => Promise<void> {
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const mkdir = options.mkdir ?? fs.mkdir;
  const writeFile = options.writeFile ?? fs.writeFile;
  const directory = path.join(homeDirectory, extensionDataDirectory);
  const handoffFile = path.join(directory, "vst3-bridge-url.txt");

  return async (value, signal) => {
    throwIfAborted(signal);
    assertVst3ChatBridgeLaunchUrl(value);
    await mkdir(directory, { recursive: true });
    throwIfAborted(signal);
    await writeFile(handoffFile, `${value}\n`, { encoding: "utf8", mode: 0o600 });
    throwIfAborted(signal);
  };
}

export function assertVst3ChatBridgeLaunchUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Live Smith requires a valid local ChatBridge launch URL.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/chat" ||
    url.searchParams.size !== 1 ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Live Smith requires a valid local ChatBridge launch URL.");
  }
  const launch = url.searchParams.get("launch");
  const token = url.searchParams.get("token");
  if (
    !(launch !== null && launchTicket.test(launch)) &&
    !(token !== null && launchTicket.test(token))
  ) {
    throw new Error("Live Smith requires a valid local ChatBridge launch URL.");
  }
}

export const openChatInVst3 = createVst3HandoffOpener();
