import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import process from "node:process";
import { URL } from "node:url";

import { throwIfAborted } from "./host.js";
import { isolatedNativeBuild } from "./native-isolation.js";

declare const __LIVE_SMITH_COMPANION_CAPSULE__: string;

const appPaths = ["Contents/MacOS/SmithCompanion", "Contents/Info.plist", "Contents/_CodeSignature/CodeResources"];
const launchTicket = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface SmithCompanionCapsule {
  version: 1;
  files: Array<{ path: string; base64: string; sha256: string }>;
}

export interface SmithCompanionOpenerOptions {
  platform?: NodeJS.Platform;
  /** Test seam; production stages the verified native capsule. */
  launch?: (url: string, signal?: AbortSignal) => Promise<void | "already-running">;
}

/** Opens one modeless native host for the already-authenticated current bridge. */
export function createSmithCompanionOpener(
  options: SmithCompanionOpenerOptions = {},
): (url: string, signal?: AbortSignal) => Promise<void> {
  const platform = options.platform ?? process.platform;
  const launch = options.launch ?? launchNativeCompanion;
  return async (url, signal) => {
    if (isolatedNativeBuild) throw new Error("Smith Companion is unavailable in the isolated native test.");
    throwIfAborted(signal);
    assertCompanionLaunchUrl(url);
    if (platform !== "darwin") {
      throw new Error("Smith Companion is available only on macOS.");
    }
    const result = await launch(url, signal);
    throwIfAborted(signal);
    if (result === "already-running") {
      throw new Error("Smith Companion is already open; fresh invocation handoff is not implemented yet.");
    }
  };
}

function assertCompanionLaunchUrl(value: string): void {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new Error("Smith Companion requires a valid local ChatBridge launch URL.");
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
    throw new Error("Smith Companion requires a valid local ChatBridge launch URL.");
  }
}

async function launchNativeCompanion(url: string, signal?: AbortSignal): Promise<"already-running" | void> {
  throwIfAborted(signal);
  const capsule = readCapsule();
  const app = await stageNativeCompanion(capsule);
  throwIfAborted(signal);
  return await launchStableNativeCompanion(app, url);
}

async function stageNativeCompanion(capsule: SmithCompanionCapsule): Promise<string> {
  const directory = path.join(homedir(), "Library", "Application Support", "Live Smith");
  const app = path.join(directory, "Smith Companion.app");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (await isCurrentCapsule(app, capsule)) return app;
  try {
    await fs.access(app);
    throw new Error("Quit Smith Companion before updating its native host.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = await fs.mkdtemp(path.join(directory, ".Smith Companion.staging-"));
  try {
    for (const [index, file] of capsule.files.entries()) {
      if (file.path !== appPaths[index]) throw new Error("Smith Companion capsule is invalid.");
      const bytes = Buffer.from(file.base64, "base64");
      if (digest(bytes) !== file.sha256) throw new Error("Smith Companion capsule is invalid.");
      const target = path.join(staging, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, bytes, { mode: index === 0 ? 0o700 : 0o600, flag: "wx" });
    }
    await fs.rename(staging, app);
    return app;
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function isCurrentCapsule(app: string, capsule: SmithCompanionCapsule): Promise<boolean> {
  try {
    for (const [index, file] of capsule.files.entries()) {
      if (file.path !== appPaths[index]) return false;
      if (digest(await fs.readFile(path.join(app, file.path))) !== file.sha256) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function launchStableNativeCompanion(app: string, url: string): Promise<"already-running" | void> {
  const child = spawn(path.join(app, appPaths[0]!), [url], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  const result = await new Promise<"already-running" | void>((resolve, reject) => {
    const timer = setTimeout(resolve, 500);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 75) resolve("already-running");
      else reject(new Error("Smith Companion failed to start."));
    });
  });
  child.unref();
  return result;
}

function readCapsule(): SmithCompanionCapsule {
  let value: SmithCompanionCapsule;
  try { value = JSON.parse(__LIVE_SMITH_COMPANION_CAPSULE__) as SmithCompanionCapsule; } catch {
    throw new Error("Smith Companion is unavailable.");
  }
  if (value.version !== 1 || !Array.isArray(value.files) || value.files.length !== appPaths.length) {
    throw new Error("Smith Companion is unavailable.");
  }
  return value;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
