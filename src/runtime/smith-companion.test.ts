import assert from "node:assert/strict";
import test from "node:test";

import { createSmithCompanionOpener } from "./smith-companion.js";

test("Smith Companion accepts only a one-time loopback chat launch URL", async () => {
  const opened: string[] = [];
  const open = createSmithCompanionOpener({
    platform: "darwin",
    launch: async (url) => { opened.push(url); },
  });

  const url = "http://127.0.0.1:61234/chat?launch=7b932446-44e3-4e8d-a1fe-a447011fbeb5";
  await open(url);
  assert.deepEqual(opened, [url]);

  for (const invalid of [
    "https://127.0.0.1:61234/chat?launch=7b932446-44e3-4e8d-a1fe-a447011fbeb5",
    "http://localhost:61234/chat?launch=7b932446-44e3-4e8d-a1fe-a447011fbeb5",
    "http://127.0.0.1:61234/state?launch=7b932446-44e3-4e8d-a1fe-a447011fbeb5",
    "http://127.0.0.1:61234/chat?launch=not-a-ticket",
    "http://127.0.0.1:61234/chat?launch=7b932446-44e3-4e8d-a1fe-a447011fbeb5&extra=1",
  ]) {
    await assert.rejects(open(invalid), /Smith Companion requires a valid local ChatBridge launch URL/);
  }
});

test("Smith Companion reports unsupported platforms without launching", async () => {
  const open = createSmithCompanionOpener({
    platform: "win32",
    launch: async () => assert.fail("must not launch"),
  });
  await assert.rejects(
    open("http://127.0.0.1:61234/chat?launch=7b932446-44e3-4e8d-a1fe-a447011fbeb5"),
    /available only on macOS/,
  );
});

test("Smith Companion rejects a fresh invocation when the single native host is already running", async () => {
  const open = createSmithCompanionOpener({
    platform: "darwin",
    launch: async () => "already-running",
  });

  await assert.rejects(
    open("http://127.0.0.1:61234/chat?launch=7b932446-44e3-4e8d-a1fe-a447011fbeb5"),
    /already open; fresh invocation handoff is not implemented yet/,
  );
});
