import { Blob, Buffer, File, btoa } from "node:buffer";
import { webcrypto } from "node:crypto";
import process from "node:process";
import { ReadableStream, TransformStream } from "node:stream/web";
import { MessagePort } from "node:worker_threads";
import { clearImmediate, setImmediate, clearTimeout, setTimeout } from "node:timers";
import { URL, URLSearchParams } from "node:url";
import { TextDecoder, TextEncoder } from "node:util";

// Bundled network libraries expect these Node globals, but Ableton's
// extension VM intentionally exposes only a small runtime surface.
const global = globalThis;
if (globalThis.crypto === undefined) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
}

export { Blob, Buffer, File, btoa, TextDecoder, TextEncoder, URLSearchParams, clearImmediate, clearTimeout, global, process, setImmediate, setTimeout, ReadableStream, TransformStream, MessagePort, URL };

export function queueMicrotask(callback: () => void): void {
  void Promise.resolve().then(() => {
    callback();
  }).catch((error: unknown) => {
    setImmediate(() => { throw error; });
  });
}
