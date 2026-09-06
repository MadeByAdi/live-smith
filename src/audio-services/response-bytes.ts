import { Buffer } from "node:buffer";

import { cancelStreamBestEffort, releaseReaderLockBestEffort } from "../model/transports/stream-cancel.js";
import { waitForPromiseWithSignal, yieldToHost } from "../runtime/host.js";

/** Read Fetch's decoded body; request policy and deadlines belong to the adapter. */
export async function readAudioResponseBytes(response: Response, options: {
  maximumBytes: number;
  signal: AbortSignal;
  active: (signal: AbortSignal) => void;
  fail: (message: string) => Error;
  /** Direct paid audio may finish at the same instant as Stop. Never infer EOF. */
  preserveCompletedOnAbort?: boolean;
}): Promise<Uint8Array> {
  const { maximumBytes, signal, active, fail, preserveCompletedOnAbort = false } = options;
  active(signal);
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximumBytes)) {
    throw fail("response exceeds the byte limit or has an invalid Content-Length.");
  }
  const wireLength = length === null ? undefined : Number(length);
  // Fetch decodes content codings but retains the encoded Content-Length.
  // Only an identity response has a length comparable to the body bytes here.
  // The host still detects truncated HTTP; every decoded chunk is bounded below.
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  const decodedLength = !encoding || encoding === "identity" ? wireLength : undefined;
  if (!response.body || wireLength === 0) throw fail("empty response body.");
  const reader = response.body.getReader();
  // Allocate by payload bytes, never by the number of (possibly empty) chunks.
  const blocks: Buffer[] = [];
  const blockSize = 64 * 1024;
  let total = 0;
  let reads = 0;
  let finished = false;
  try {
    while (true) {
      active(signal);
      let receivedEOF = false;
      const reading = reader.read().then(value => { receivedEOF = value.done; return value; });
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await waitForPromiseWithSignal(reading, signal);
      } catch (error) {
        // Observe EOF already settling this turn without waiting for an
        // unfinished read. Cancelling the reader here could manufacture EOF.
        await Promise.resolve();
        if (!preserveCompletedOnAbort || !receivedEOF) throw error;
        finished = true;
        break;
      }
      if (!preserveCompletedOnAbort) active(signal);
      if (result.done) { finished = true; break; }
      active(signal);
      const chunk = result.value;
      if (total + chunk.byteLength > maximumBytes) {
        throw fail(`response exceeds the byte limit (${maximumBytes / (1024 * 1024)} MiB).`);
      }
      if (decodedLength !== undefined && total + chunk.byteLength > decodedLength) {
        throw fail("response does not match Content-Length.");
      }
      for (let offset = 0; offset < chunk.byteLength;) {
        const used = total % blockSize;
        if (!used) blocks.push(Buffer.allocUnsafe(blockSize));
        const count = Math.min(blockSize - used, chunk.byteLength - offset);
        blocks[blocks.length - 1]!.set(chunk.subarray(offset, offset + count), used);
        total += count;
        offset += count;
      }
      // Even eager empty streams must allow Stop and deadline callbacks to run.
      if (++reads % 64 === 0) await yieldToHost(signal);
    }
    if (!total) throw fail("empty response body.");
    if (decodedLength !== undefined && total !== decodedLength) {
      throw fail("response does not match Content-Length.");
    }
    return Buffer.concat(blocks, total);
  } finally {
    if (!finished) cancelStreamBestEffort(reader);
    releaseReaderLockBestEffort(reader);
  }
}
