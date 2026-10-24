import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import test from "node:test";
import { openVerifiedFileStream } from "../../src/storage/file-export.js";

test("private file exports stream bounded chunks and reject hash changes or symlinks", async t => {
  const directory = await mkdtemp("/private/tmp/live-smith-export-"); t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = new Uint8Array(3 * 1024 * 1024).fill(37), path = `${directory}/asset`;
  await writeFile(path, bytes);
  const input = { path, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), signal: new AbortController().signal, assertCurrent: async () => {} };
  const stream = await openVerifiedFileStream(input);
  let size = 0;
  for await (const chunk of stream) { assert(chunk.length <= 128 * 1024); size += chunk.length; }
  assert.equal(size, bytes.length);
  await assert.rejects(openVerifiedFileStream({ ...input, sha256: "0".repeat(64) }), /integrity/);
  await symlink(path, `${directory}/link`);
  await assert.rejects(openVerifiedFileStream({ ...input, path: `${directory}/link` }), /changed|unavailable/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(openVerifiedFileStream({ ...input, signal: abort.signal }), { name: "AbortError" });
});
