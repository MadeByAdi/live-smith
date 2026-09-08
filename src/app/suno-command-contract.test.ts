import assert from "node:assert/strict";
import test from "node:test";
import { parseCommandInput } from "./chat-bridge-http.js";

test("opening the Suno website accepts no destination, connection or credential", () => {
  assert.deepEqual(parseCommandInput({ kind: "open_suno_website" }), { kind: "open_suno_website" });
  for (const extra of [{ serviceId: "suno-one" }, { url: "https://example.test" }, { cookie: "fixture-secret" }]) {
    assert.throws(() => parseCommandInput({ kind: "open_suno_website", ...extra }));
  }
  assert.throws(() => parseCommandInput({ kind: "open_suno_login", serviceId: "suno-one" }));
});

test("Suno Cookie import has a separate bounded credential command", () => {
  const input = { kind: "import_suno_session", serviceId: "suno-one", sessionValue: "header.payload.signature" };
  assert.deepEqual(parseCommandInput(input), input);
  for (const extra of [{ serviceId: "../outside" }, { sessionValue: "" }, { sessionValue: "x".repeat(8193) },
    { sessionValue: "line\r\nheader" }, { sessionValue: 42 }, { password: "fixture-secret" }, { url: "https://example.test" }]) {
    assert.throws(() => parseCommandInput({ ...input, ...extra }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /fixture-secret|line\r\nheader/);
      return true;
    });
  }
});

test("checking and disconnecting Suno cannot carry browser data or redirect destinations", () => {
  for (const kind of ["refresh_suno_login", "logout_suno"]) {
    assert.deepEqual(parseCommandInput({ kind, serviceId: "suno-one" }), { kind, serviceId: "suno-one" });
    for (const extra of [{ cookie: "fixture" }, { sessionValue: "fixture" }, { serviceId: "../outside" }, { url: "https://suno.com" }]) {
      assert.throws(() => parseCommandInput({ kind, serviceId: "suno-one", ...extra }));
    }
  }
});
