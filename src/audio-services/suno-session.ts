import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";
import { TextDecoder } from "node:util";
import { cancelStreamBestEffort } from "../model/transports/stream-cancel.js";
import { createHostAbortController, resolveFetchImplementation, waitForPromiseWithSignal } from "../runtime/host.js";
import { readAudioResponseBytes } from "./response-bytes.js";
import type { SunoSessionIdentity, SunoSessionVerifier } from "./suno-session-contracts.js";

const CLIENT_URL = "https://auth.suno.com/v1/client?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0";
const MAX_TOKEN_LENGTH = 8192;
const REQUEST_TIMEOUT_MS = 15_000;

export class SunoSessionExpiredError extends Error {
  constructor() {
    super("The Suno session has expired or signed out. Import a current Suno session again.");
    this.name = "SunoSessionExpiredError";
  }
}

export class SunoSessionUnavailableError extends Error {
  constructor() {
    super("Suno session verification is unavailable. Try again or import a current Suno session.");
    this.name = "SunoSessionUnavailableError";
  }
}

/** Format validation only; account evidence must come from the fixed Suno endpoint. */
export function normalizeSunoSessionValue(value: unknown): string {
  const invalid = () => new Error("Enter only a Suno client session value or a single __client= assignment.");
  if (typeof value !== "string" || value.length > MAX_TOKEN_LENGTH + 32) throw invalid();
  const input = value.trim();
  const token = input.startsWith("__client=") ? input.slice(9) : input;
  if (token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(token) ||
    token.split(".").some((part) => Buffer.from(part, "base64url").toString("base64url") !== part)) throw invalid();
  return token;
}

/** Shared private-record boundary: copy only bounded, credential-free identity. */
export function normalizeSunoSessionIdentity(value: unknown, token: string): SunoSessionIdentity {
  const input = object(value);
  const accountId = identifier(input.accountId);
  const accountName = name(input.accountName, token);
  if (!/^user_[A-Za-z0-9_-]+$/u.test(accountId) || accountId.includes(token)) throw new SunoSessionUnavailableError();
  return { accountId, ...(accountName ? { accountName } : {}) };
}

export function createSunoSessionVerifier(injected?: typeof fetch): SunoSessionVerifier {
  const resolve = createSunoActiveSessionResolver(injected);
  return async (clientToken, signal) => {
    const { sessionId: _sessionId, ...identity } = await resolve(clientToken, signal);
    return identity;
  };
}

/** Private HTTP boundary only; never project the Clerk session ID into UI state. */
export function createSunoActiveSessionResolver(injected?: typeof fetch): (
  clientToken: string, signal: AbortSignal,
) => Promise<SunoSessionIdentity & { sessionId: string }> {
  return async (clientToken, signal) => {
    active(signal);
    const token = normalizeSunoSessionValue(clientToken);
    let controller: AbortController;
    try { controller = createHostAbortController(); }
    catch { throw new SunoSessionUnavailableError(); }
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(onAbort, REQUEST_TIMEOUT_MS);
    let response: Response | undefined;
    try {
      const pending = Promise.resolve(resolveFetchImplementation(injected)(CLIENT_URL, {
        method: "GET", redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
        signal: controller.signal,
        headers: { Authorization: token, Cookie: `__client=${token}`, Accept: "application/json",
          Origin: "https://suno.com", Referer: "https://suno.com/" },
      }));
      void pending.then((late) => {
        if (controller.signal.aborted) cancelStreamBestEffort(late.body);
      }, () => undefined);
      response = await waitForPromiseWithSignal(pending, controller.signal);
      active(controller.signal);
      if (response.redirected || (response.url && response.url !== CLIENT_URL)) throw new SunoSessionUnavailableError();
      if (response.status === 401) throw new SunoSessionExpiredError();
      if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        throw new SunoSessionUnavailableError();
      }
      const bytes = await readAudioResponseBytes(response, {
        maximumBytes: 64 * 1024, signal: controller.signal, active, fail: () => new SunoSessionUnavailableError(),
      });
      active(controller.signal);
      return clientIdentity(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), token);
    } catch (error) {
      controller.abort();
      cancelStreamBestEffort(response?.body);
      active(signal);
      // Never retain provider-controlled messages, bodies, or exception causes.
      if (error instanceof SunoSessionExpiredError) throw new SunoSessionExpiredError();
      throw new SunoSessionUnavailableError();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  };
}

function active(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Suno session verification was cancelled.");
  error.name = "AbortError";
  throw error;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SunoSessionUnavailableError();
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) throw new SunoSessionUnavailableError();
  return value;
}

function name(value: unknown, token: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f]/u.test(value) || value.includes(token)) throw new SunoSessionUnavailableError();
  return value.trim().slice(0, 160).replace(/[\uD800-\uDBFF]$/u, "").trimEnd() || undefined;
}

function clientIdentity(value: unknown, token: string): SunoSessionIdentity & { sessionId: string } {
  // Clerk FAPI 2025-11-10: Client.Client -> Client.Session -> Client.User.
  // https://github.com/clerk/openapi-specs/blob/main/fapi/2025-11-10.yml
  const client = object(object(value).response);
  if (client.object !== "client" || !Array.isArray(client.sessions)) throw new SunoSessionUnavailableError();
  if (client.last_active_session_id === null) throw new SunoSessionExpiredError();
  const selectedId = identifier(client.last_active_session_id);
  const matches = client.sessions.filter((entry: unknown) => object(entry).id === selectedId);
  if (!matches.length) throw new SunoSessionExpiredError();
  if (matches.length !== 1) throw new SunoSessionUnavailableError();
  const session = object(matches[0]);
  if (session.object !== "session") throw new SunoSessionUnavailableError();
  if (["expired", "revoked", "ended", "removed", "abandoned"].includes(String(session.status))) throw new SunoSessionExpiredError();
  if (session.status !== "active" || typeof session.expire_at !== "number" || !Number.isSafeInteger(session.expire_at)) {
    throw new SunoSessionUnavailableError();
  }
  if (session.expire_at <= Date.now()) throw new SunoSessionExpiredError();
  const user = object(session.user);
  if (user.object !== "user") throw new SunoSessionUnavailableError();
  const fullName = [name(user.first_name, token), name(user.last_name, token)].filter(Boolean).join(" ");
  const accountName = fullName || name(user.username, token);
  return { ...normalizeSunoSessionIdentity({ accountId: user.id, accountName }, token), sessionId: selectedId };
}
