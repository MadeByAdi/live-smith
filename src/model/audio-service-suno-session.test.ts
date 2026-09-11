import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { ReadableStream } from "node:stream/web";
import { createHostAbortController } from "../runtime/host.js";
import { createSunoSessionVerifier, normalizeSunoSessionValue, SunoSessionExpiredError } from "../audio-services/suno-session.js";

const token = [Buffer.from('{"alg":"HS256"}'), Buffer.from('{"sub":"client_synthetic"}'), Buffer.from("synthetic-signature")]
  .map((part) => part.toString("base64url")).join(".");
const endpoint = "https://auth.suno.com/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0";
const signal = () => createHostAbortController().signal;
const session = (id = "sess_selected", accountId = "user_selected") => ({
  object: "session", id, status: "active", expire_at: Date.now() + 60_000,
  user: { object: "user", id: accountId, first_name: "Ada", last_name: "Lovelace", username: "ada" },
});
const payload = (sessions: unknown[] = [session()], selected: unknown = "sess_selected") => ({
  response: { object: "client", id: "client_synthetic", last_active_session_id: selected, sessions },
});
function verifier(value: unknown) {
  return createSunoSessionVerifier(async () => Response.json(value));
}
function safeFailure(error: unknown): boolean {
  assert.ok(error instanceof Error);
  assert.ok(!String(error.stack).includes(token));
  assert.equal(error.cause, undefined);
  return true;
}

test("normalization accepts one explicit client cookie or raw JWT, never bulk cookies", () => {
  assert.equal(normalizeSunoSessionValue(`  ${token}  `), token);
  assert.equal(normalizeSunoSessionValue(`__client=${token}`), token);
  for (const value of [null, {}, 1, "", "a.b.c", `Bearer ${token}`, `Cookie: __client=${token}`,
    `__client=${token}; other=secret`, `__client=${token};`, `__client=${token}\r\nX-Test: injected`,
    `__client =${token}`, `${token}=`, `${token}.extra`, "a".repeat(9000)]) {
    assert.throws(() => normalizeSunoSessionValue(value), safeFailure);
  }
});

test("verification makes one fixed GET with only the imported credential and returns bounded selected user fields", async () => {
  let calls = 0;
  const verify = createSunoSessionVerifier(async (url, init) => {
    calls++;
    assert.equal(url, endpoint);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.equal(init?.body, undefined);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Authorization"), token);
    assert.equal(headers.get("Cookie"), `__client=${token}`);
    assert.equal(headers.get("User-Agent"), null);
    assert.equal(headers.get("browser-token"), null);
    return Response.json(payload([session("sess_other", "user_other"), session()]));
  });
  assert.deepEqual(await verify(token, signal()), { accountId: "user_selected", accountName: "Ada Lovelace" });
  assert.equal(calls, 1);
});

test("verification accepts a bounded provider account ID without the legacy Clerk prefix", async () => {
  assert.deepEqual(await verifier(payload([session("sess_selected", "account-selected")]))(token, signal()), {
    accountId: "account-selected", accountName: "Ada Lovelace",
  });
});

test("last active session never falls back to another account or a public user stub", async () => {
  for (const value of [payload([session("sess_other")]), payload([session()], null),
    payload([{ ...session(), status: "expired" }]), payload([{ ...session(), expire_at: Date.now() - 1 }])]) {
    await assert.rejects(verifier(value)(token, signal()), SunoSessionExpiredError);
  }
  for (const value of [payload([session(), session()]), payload([{ ...session(), status: "pending" }]),
    payload([{ ...session(), user: undefined, public_user_data: { user_id: "user_stub" } }]),
    payload([{ ...session(), user: { id: "user_wrong_object", object: "organization" } }]),
    payload([{ ...session(), expire_at: "tomorrow" }]), { response: { sessions: [session()] } }]) {
    await assert.rejects(verifier(value)(token, signal()), (error) => {
      assert.ok(!(error instanceof SunoSessionExpiredError)); return safeFailure(error);
    });
  }
});

test("identity excludes metadata, invalid account IDs, controls and credential echoes", async () => {
  for (const user of [{ ...session().user, id: token }, { ...session().user, first_name: token },
    { ...session().user, id: "account/other" }, { ...session().user, first_name: "Ada\nCookie" }]) {
    await assert.rejects(verifier(payload([{ ...session(), user }]))(token, signal()), safeFailure);
  }
  assert.deepEqual(await verifier(payload([{ ...session(), user: {
    object: "user", id: "user_only", first_name: null, last_name: null, username: null,
    private_metadata: { token }, email_addresses: [{ email_address: "private@example.test" }],
  } }]))(token, signal()), { accountId: "user_only" });
});

test("long verified display names are bounded without discarding the account identity", async () => {
  for (const user of [{ ...session().user, first_name: "A".repeat(150), last_name: "B".repeat(150) },
    { ...session().user, first_name: "A".repeat(500), last_name: null }]) {
    const identity = await verifier(payload([{ ...session(), user }]))(token, signal());
    assert.equal(identity.accountId, "user_selected");
    assert.equal(identity.accountName?.length, 160);
  }
});

test("a dotted username is a valid account label when the full name is absent", async () => {
  const user = { ...session().user, first_name: null, last_name: null, username: "sam.kuler.music" };
  assert.deepEqual(await verifier(payload([{ ...session(), user }]))(token, signal()), {
    accountId: "user_selected", accountName: "sam.kuler.music",
  });
});

test("401 is expired, other failures are unavailable and discard response bodies and exception causes", async () => {
  for (const status of [401, 403, 429, 500, 302]) {
    let cancelled = false;
    const verify = createSunoSessionVerifier(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(token)); }, cancel() { cancelled = true; },
    }) as unknown as BodyInit, { status, headers: { location: "https://example.test/" } }));
    await assert.rejects(verify(token, signal()), (error) => {
      assert.equal(error instanceof SunoSessionExpiredError, status === 401); return safeFailure(error);
    });
    assert.equal(cancelled, true);
  }
  await assert.rejects(createSunoSessionVerifier(async () => {
    throw new Error(token, { cause: new Error(token) });
  })(token, signal()), safeFailure);
});

test("redirected responses, malformed JSON, media types and both advertised and streamed oversized bodies are rejected", async () => {
  const redirected = Response.json(payload());
  Object.defineProperty(redirected, "redirected", { value: true });
  for (const response of [new Response(token, { headers: { "content-type": "application/json" } }),
    new Response("{}", { headers: { "content-type": "text/html" } }),
    new Response("{}", { headers: { "content-type": "application/json", "content-length": "9999999" } }),
    new Response(" ".repeat(65 * 1024), { headers: { "content-type": "application/json" } }),
    redirected]) {
    await assert.rejects(createSunoSessionVerifier(async () => response)(token, signal()), safeFailure);
  }
});

test("cancellation bounds pending Fetch and pending body reads without echoing abort reasons", async () => {
  const controller = createHostAbortController();
  let requestSignal: AbortSignal | null | undefined;
  const started = Promise.withResolvers<void>();
  const verify = createSunoSessionVerifier(async (_url, init) => {
    requestSignal = init?.signal; started.resolve(); return new Promise<Response>(() => {});
  });
  const pending = verify(token, controller.signal);
  await started.promise;
  controller.abort(new Error(token));
  await assert.rejects(pending, (error) => { assert.equal((error as Error).name, "AbortError"); return safeFailure(error); });
  assert.equal(requestSignal?.aborted, true);

  const bodyController = createHostAbortController();
  const reading = Promise.withResolvers<void>();
  let cancelled = false;
  const bodyPending = createSunoSessionVerifier(async () => new Response(new ReadableStream({
    pull() { reading.resolve(); }, cancel() { cancelled = true; },
  }) as unknown as BodyInit, { headers: { "content-type": "application/json" } }))(token, bodyController.signal);
  await reading.promise;
  bodyController.abort(new Error(token));
  await assert.rejects(bodyPending, safeFailure);
  assert.equal(cancelled, true);
});

test("deadline bounds an unresponsive Fetch and cleans up a late response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  syncBuiltinESMExports();
  t.after(() => { t.mock.timers.reset(); syncBuiltinESMExports(); });
  const late = Promise.withResolvers<Response>();
  let requestSignal: AbortSignal | null | undefined;
  const pending = createSunoSessionVerifier(async (_url, init) => {
    requestSignal = init?.signal; return late.promise;
  })(token, signal());
  t.mock.timers.tick(15_000);
  await assert.rejects(pending, (error) => {
    assert.ok(!(error instanceof SunoSessionExpiredError)); return safeFailure(error);
  });
  assert.equal(requestSignal?.aborted, true);
  const cancelled = Promise.withResolvers<void>();
  late.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve(); } }) as unknown as BodyInit));
  await cancelled.promise;
});

test("invalid and pre-cancelled input never reaches Fetch", async () => {
  let calls = 0;
  const verify = createSunoSessionVerifier(async () => { calls++; return Response.json(payload()); });
  await assert.rejects(verify(`__client=${token}; other=private`, signal()), safeFailure);
  const controller = createHostAbortController(); controller.abort(new Error(token));
  await assert.rejects(verify(token, controller.signal), safeFailure);
  assert.equal(calls, 0);
});
