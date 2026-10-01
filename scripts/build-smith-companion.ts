import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = "src/runtime/native";
const receipt = `${root}/smith-companion-capsule.json`;
const sources = [`${root}/smith-companion.m`, `${root}/smith-companion-Info.plist`, "scripts/build-smith-companion.ts"];
const paths = ["Contents/MacOS/SmithCompanion", "Contents/Info.plist", "Contents/_CodeSignature/CodeResources"];
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

export interface SmithCompanionCapsule { version: 1; sourceDigest: string; files: Array<{ path: string; base64: string; sha256: string }>; }

export async function readSmithCompanionCapsule(): Promise<SmithCompanionCapsule> {
  const hash = createHash("sha256");
  for (const source of sources) hash.update(source).update(await fs.readFile(source));
  const sourceDigest = hash.digest("hex");
  let capsule: SmithCompanionCapsule | undefined;
  try { capsule = JSON.parse(await fs.readFile(receipt, "utf8")) as SmithCompanionCapsule; } catch {}
  if (capsule?.version !== 1 || capsule.sourceDigest !== sourceDigest) {
    if (process.platform !== "darwin") throw new Error("Smith Companion capsule is stale; rebuild it on macOS.");
    capsule = await compile(sourceDigest);
    await fs.writeFile(receipt, JSON.stringify(capsule) + "\n");
  }
  if (capsule.files.length !== paths.length || capsule.files.some((file, index) => file.path !== paths[index] || file.sha256 !== digest(Buffer.from(file.base64, "base64")))) {
    throw new Error("Smith Companion capsule failed verification.");
  }
  return capsule;
}

async function compile(sourceDigest: string): Promise<SmithCompanionCapsule> {
  const temporary = await fs.mkdtemp(path.join(tmpdir(), "live-smith-companion-build-"));
  try {
    const app = path.join(temporary, "Smith Companion.app");
    await fs.mkdir(path.join(app, "Contents/MacOS"), { recursive: true });
    await fs.copyFile(`${root}/smith-companion-Info.plist`, path.join(app, "Contents/Info.plist"));
    await run("/Library/Developer/CommandLineTools/usr/bin/clang", ["-fobjc-arc", "-arch", "arm64", "-arch", "x86_64", "-mmacosx-version-min=14.0", "-isysroot", "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk", "-framework", "Cocoa", "-framework", "WebKit", `${root}/smith-companion.m`, "-o", path.join(app, paths[0]!)], { timeout: 120_000, maxBuffer: 256_000 });
    await run("/usr/bin/codesign", ["--force", "--sign", "-", "--identifier", "dev.livesmith.companion-proof", app], { timeout: 30_000, maxBuffer: 256_000 });
    await run("/usr/bin/codesign", ["--verify", "--strict", app], { timeout: 30_000, maxBuffer: 256_000 });
    const files = [];
    for (const file of paths) { const bytes = await fs.readFile(path.join(app, file)); files.push({ path: file, base64: bytes.toString("base64"), sha256: digest(bytes) }); }
    return { version: 1, sourceDigest, files };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
