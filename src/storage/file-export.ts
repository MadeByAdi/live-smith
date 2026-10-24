import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { platform } from "node:process";
import { Readable, addAbortSignal } from "node:stream";
import { safeRegularFileOpenFlags } from "../live/safe-file-read.js";
import { throwIfAborted } from "../runtime/host.js";

export interface SessionFileExport {
  fileName: string;
  mediaType: string;
  byteLength: number;
  open(signal: AbortSignal): Promise<Readable>;
}

/** Immutable stored bytes are tied to their write-time format inspection by SHA-256. */
export async function openVerifiedFileStream(input: {
  path: string; byteLength: number; sha256: string; signal: AbortSignal; assertCurrent(): Promise<void>;
}): Promise<Readable> {
  throwIfAborted(input.signal);
  await input.assertCurrent();
  const before = await fs.lstat(input.path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size !== BigInt(input.byteLength)) throw new Error("Stored file is unavailable or changed.");
  const handle = await fs.open(input.path, safeRegularFileOpenFlags(constants));
  let handedOff = false;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1n) throw new Error("Stored file changed while opening.");
    if (platform !== "win32" && (opened.mode & 0o7777n) !== 0o600n) await handle.chmod(0o600);
    const assertStable = async () => {
      throwIfAborted(input.signal);
      const current = await handle.stat({ bigint: true });
      if (current.size !== before.size || current.mtimeNs !== before.mtimeNs || current.nlink !== 1n) throw new Error("Stored file changed while reading.");
      await input.assertCurrent();
    };
    async function* chunks() {
      for (let offset = 0; offset < input.byteLength;) {
        throwIfAborted(input.signal);
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, input.byteLength - offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (bytesRead === 0) throw new Error("Stored file ended before its recorded length.");
        offset += bytesRead; yield chunk.subarray(0, bytesRead);
      }
    }
    const verified = createHash("sha256");
    for await (const chunk of chunks()) verified.update(chunk);
    if (verified.digest("hex") !== input.sha256) throw new Error("Stored file integrity check failed.");
    await assertStable();
    const stream = Readable.from((async function* () {
      const hash = createHash("sha256");
      let last: Buffer | undefined;
      try {
        for await (const chunk of chunks()) { hash.update(chunk); if (last) yield last; last = chunk; }
        await assertStable();
        if (hash.digest("hex") !== input.sha256) throw new Error("Stored file changed during export.");
        if (last) yield last;
      } finally { await handle.close(); }
    })(), { highWaterMark: 64 * 1024, objectMode: false });
    // Also release a lease destroyed before the async iterator is first pulled.
    stream.once("close", () => { void handle.close().catch(() => {}); });
    addAbortSignal(input.signal, stream);
    handedOff = true;
    return stream;
  } finally { if (!handedOff) await handle.close(); }
}
