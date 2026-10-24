import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

declare const __LIVE_SMITH_ISOLATED_NATIVE_BUILD__: boolean;

export const isolatedNativeBuild = typeof __LIVE_SMITH_ISOLATED_NATIVE_BUILD__ !== "undefined" &&
  __LIVE_SMITH_ISOLATED_NATIVE_BUILD__;
export const isolatedNativeId = "t7-startup-isolation-lab.t7-live-smith-native-dev-20261012";

export function assertIsolatedNativeStorage(storageDirectory: string | undefined): void {
  if (!isolatedNativeBuild) return;
  const expected = path.join(homedir(), "Library", "Application Support", "Ableton", "Extensions Data", isolatedNativeId);
  try {
    if (!storageDirectory || path.resolve(storageDirectory) !== expected ||
      realpathSync(storageDirectory) !== path.join(realpathSync(path.dirname(expected)), isolatedNativeId)) {
      throw new Error();
    }
  } catch {
    throw new Error("Isolated Live Smith storage identity is unavailable.");
  }
}
