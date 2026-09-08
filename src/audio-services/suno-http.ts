import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { TextDecoder } from "node:util";

import { cancelStreamBestEffort } from "../model/transports/stream-cancel.js";
import { createHostAbortController, resolveFetchImplementation, waitForPromiseWithSignal } from "../runtime/host.js";
import { MAX_AUDIO_ASSET_BYTES } from "./contracts.js";
import { readAudioResponseBytes } from "./response-bytes.js";
import { createSunoActiveSessionResolver, normalizeSunoSessionIdentity, normalizeSunoSessionValue,
  SunoSessionExpiredError } from "./suno-session.js";

const API_BASE = "https://studio-api-prod.suno.com";
const AUTH_BASE = "https://auth.suno.com/v1/client/sessions/";
const AUTH_QUERY = "?__clerk_api_version=2025-11-10&_clerk_js_version=5.117.0";
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_AUTH_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const AUTH_TIMEOUT_MS = 15_000;
const SUBMIT_STOP_GRACE_MS = 3_000;
const TOKEN_REFRESH_MARGIN_MS = 10_000;
const MAX_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const UUID = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
const FEED_IDS = new RegExp(`^/api/feed/\\?ids=${UUID}(?:,${UUID}){0,49}$`, "u");
const PERSONA = new RegExp(`^/api/persona/get-persona-paginated/${UUID}/\\?page=(?:0|[1-9][0-9]{0,3})$`, "u");
// Public response examples: https://github.com/serkansmg/SunoApiManager/blob/main/API.md
// Exact provider CDN hosts only; no suffix matching or caller-selected API hosts.
const AUDIO_HOSTS = new Set(["cdn1.suno.ai", "cdn2.suno.ai", "cdn.suno.ai"]);

class SunoHttpError extends Error {}

/** Trusted local diagnostics only; network failures never supply their messages. */
function fail(detail: string): Error {
  return new SunoHttpError(`Suno.com audio service: ${detail}`);
}

function active(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = fail("request cancelled; remote generation may still complete.");
  error.name = "AbortError";
  throw error;
}

function validateJson(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > 32_768 || entry.depth > 32) throw fail("invalid protocol response.");
    if (entry.value === null || typeof entry.value === "string" || typeof entry.value === "boolean") continue;
    if (typeof entry.value === "number" && Number.isFinite(entry.value)) continue;
    if (typeof entry.value !== "object") throw fail("invalid protocol response.");
    const prototype = Object.getPrototypeOf(entry.value);
    if (!Array.isArray(entry.value) && prototype !== Object.prototype && prototype !== null) throw fail("invalid protocol response.");
    for (const [key, child] of Object.entries(entry.value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw fail("invalid protocol response.");
      pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    validateJson(value);
    return value;
  } catch { throw fail("invalid protocol response."); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("invalid protocol response.");
  return value as Record<string, unknown>;
}

function allowedRoute(method: string, path: string): boolean {
  if (typeof path !== "string" || path.length > 4096 || /[\s\\]/u.test(path)) return false;
  if (method === "GET") return path === "/api/billing/info/" || FEED_IDS.test(path) || PERSONA.test(path);
  return method === "POST" && ["/api/feed/v3", "/api/c/check", "/api/generate/v2-web/", "/api/generate/concat/v2/"].includes(path);
}

export function createSunoHttp(session: { clientToken: string; accountId: string }, injected?: typeof fetch) {
  // Snapshot the exact admitted connection; never reload mutable settings here.
  let clientToken: string;
  let accountId: string;
  try {
    clientToken = normalizeSunoSessionValue(session.clientToken);
    accountId = normalizeSunoSessionIdentity({ accountId: session.accountId }, clientToken).accountId;
    if (/[^A-Za-z0-9_-]/u.test(accountId)) throw new Error();
  } catch { throw fail("invalid saved session."); }
  const resolveSession = createSunoActiveSessionResolver(injected);
  let boundSessionId: string | undefined;
  let cached: { jwt: string; expiresAt: number } | undefined;

  const read = async (
    url: string, init: RequestInit, signal: AbortSignal, maximumBytes: number, timeoutMs: number, audio = false,
    preserveReceipt = false,
  ): Promise<Uint8Array> => {
    active(signal);
    let controller: AbortController;
    try { controller = createHostAbortController(); }
    catch { throw fail("request or response read failed; its remote outcome may be unknown."); }
    let timedOut = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      // Once paid work is submitted, briefly retain its bounded receipt so the
      // caller can persist acknowledged IDs. Never extend the original deadline.
      if (preserveReceipt) stopTimer = setTimeout(() => controller.abort(), SUBMIT_STOP_GRACE_MS);
      else controller.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    let response: Response | undefined;
    try {
      const pending = Promise.resolve(resolveFetchImplementation(injected)(url, {
        ...init, signal: controller.signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
      }));
      void pending.then((late) => {
        if (controller.signal.aborted) cancelStreamBestEffort(late.body);
      }, () => undefined);
      response = await waitForPromiseWithSignal(pending, controller.signal);
      active(controller.signal);
      if (response.redirected || (response.url && response.url !== url)) throw fail("unexpected response redirect.");
      if (response.status === 401) throw fail("session expired; import a current Suno session.");
      if (response.status === 403) throw fail("access denied or verification required; complete verification on Suno.com.");
      if (response.status !== 200) throw fail("request rejected; no automatic retry was attempted.");
      const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (audio ? !["audio/mpeg", "audio/wav", "audio/x-wav", "application/octet-stream"].includes(mime ?? "") : mime !== "application/json") {
        throw fail("invalid protocol response.");
      }
      const bytes = await readAudioResponseBytes(response, {
        maximumBytes, signal: controller.signal, active, fail,
      });
      active(controller.signal);
      return bytes;
    } catch (error) {
      controller.abort();
      cancelStreamBestEffort(response?.body);
      active(signal);
      if (timedOut) throw fail("request timed out; its remote outcome may be unknown.");
      if (error instanceof SunoHttpError) throw error;
      throw fail("request or response read failed; its remote outcome may be unknown.");
    } finally {
      clearTimeout(timer);
      clearTimeout(stopTimer);
      signal.removeEventListener("abort", onAbort);
    }
  };

  const accessToken = async (signal: AbortSignal): Promise<string> => {
    active(signal);
    if (cached && cached.expiresAt > Date.now() + TOKEN_REFRESH_MARGIN_MS) return cached.jwt;
    cached = undefined;
    let identity: Awaited<ReturnType<typeof resolveSession>>;
    try { identity = await resolveSession(clientToken, signal); }
    catch (error) {
      active(signal);
      if (error instanceof SunoSessionExpiredError) throw fail("session expired; import a current Suno session.");
      throw fail("session verification failed.");
    }
    active(signal);
    if (identity.accountId !== accountId || /[^A-Za-z0-9_-]/u.test(identity.sessionId) ||
        (boundSessionId !== undefined && identity.sessionId !== boundSessionId)) {
      throw fail("active account or session changed; reconnect Suno.");
    }
    boundSessionId = identity.sessionId;
    // Clerk FAPI Create Session Token returns {jwt}; no template or organization switch.
    // https://github.com/clerk/openapi-specs/blob/main/fapi/2025-11-10.yml
    const data = object(parseJson(await read(`${AUTH_BASE}${boundSessionId}/tokens${AUTH_QUERY}`, {
      method: "POST", body: "", headers: { Authorization: clientToken, Cookie: `__client=${clientToken}`,
        Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    }, signal, MAX_AUTH_BYTES, AUTH_TIMEOUT_MS)));
    try {
      if (typeof data.jwt !== "string" || data.jwt !== data.jwt.trim() || data.jwt.startsWith("__client=")) throw new Error();
      const jwt = normalizeSunoSessionValue(data.jwt);
      const [header, payload] = jwt.split(".");
      if (object(parseJson(Buffer.from(header!, "base64url"))).alg !== "RS256") throw new Error();
      const claims = object(parseJson(Buffer.from(payload!, "base64url")));
      if (claims.sub !== accountId || claims.sid !== boundSessionId || !Number.isSafeInteger(claims.exp)) throw new Error();
      const expiresAt = (claims.exp as number) * 1000;
      if (expiresAt <= Date.now() + TOKEN_REFRESH_MARGIN_MS || expiresAt > Date.now() + MAX_TOKEN_LIFETIME_MS) throw new Error();
      active(signal);
      cached = { jwt, expiresAt };
      return jwt;
    } catch {
      active(signal);
      throw fail("invalid session token.");
    }
  };

  const outputUrl = (value: unknown): string => {
    try {
      if (typeof value !== "string" || value.length > 4096 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) throw new Error();
      const url = new URL(value);
      const decoded = decodeURIComponent(value);
      if (url.protocol !== "https:" || !AUDIO_HOSTS.has(url.hostname) || url.port || url.username || url.password || url.hash ||
          !value.startsWith(`https://${url.hostname}/`) || url.pathname === "/" ||
          /[\s\\\u0000-\u001f\u007f]/u.test(decoded) || decoded.includes(clientToken) || (cached && decoded.includes(cached.jwt))) throw new Error();
      return url.href;
    } catch { throw fail("untrusted audio URL."); }
  };

  return {
    fail,
    outputUrl,
    /** Validate the final bounded public projection while both credentials are private here. */
    publicResult<T>(value: T): T {
      const text = JSON.stringify(value);
      if (text.includes(clientToken) || (cached && text.includes(cached.jwt))) {
        throw fail("credential-bearing public response.");
      }
      return value;
    },
    async request(method: "GET" | "POST", path: string, body: unknown | undefined, signal: AbortSignal): Promise<unknown> {
      active(signal);
      if (!allowedRoute(method, path) || (method === "GET" && body !== undefined)) throw fail("request route or body is not allowed.");
      let encoded: string | undefined;
      try {
        if (body !== undefined) {
          validateJson(body);
          encoded = JSON.stringify(body);
          if (Buffer.byteLength(encoded) > MAX_JSON_BYTES) throw new Error();
        }
      } catch { throw fail("request route or body is not allowed."); }
      const jwt = await accessToken(signal);
      active(signal);
      const preserveReceipt = method === "POST" && ["/api/generate/v2-web/", "/api/generate/concat/v2/"].includes(path);
      try {
        return parseJson(await read(`${API_BASE}${path}`, {
          method, headers: { Authorization: `Bearer ${jwt}`, Accept: "application/json",
            ...(encoded !== undefined ? { "Content-Type": "application/json" } : {}) },
          ...(encoded !== undefined ? { body: encoded } : {}),
        }, signal, MAX_JSON_BYTES, REQUEST_TIMEOUT_MS, false, preserveReceipt));
      } catch (error) {
        // No automatic retry, even for auth failures or uncertain paid submissions.
        if (cached?.jwt === jwt) cached = undefined;
        throw error;
      }
    },
    async download(value: string, signal: AbortSignal): Promise<Uint8Array> {
      active(signal);
      return read(outputUrl(value), { method: "GET", headers: { Accept: "audio/mpeg, audio/wav, application/octet-stream" } },
        signal, MAX_AUDIO_ASSET_BYTES, REQUEST_TIMEOUT_MS, true);
    },
  };
}
