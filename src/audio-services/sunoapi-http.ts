import { isIP } from "node:net";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { TextDecoder } from "node:util";

import { cancelStreamBestEffort } from "../model/transports/stream-cancel.js";
import { createHostAbortController, resolveFetchImplementation, waitForPromiseWithSignal } from "../runtime/host.js";
import { MAX_AUDIO_ASSET_BYTES } from "./contracts.js";
import { readAudioResponseBytes } from "./response-bytes.js";

const API_BASE = "https://api.sunoapi.org/api/v1/generate";
const MAX_JSON_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 120_000;
const SUBMIT_STOP_GRACE_MS = 3_000;
// The provider documents real audio downloads on this exact host at:
// https://docs.sunoapi.org/suno-api/get-vocal-separation-details
// Other output hosts remain unavailable until independently verified. A public
// DNS lookup alone would not authorize a URL or prevent DNS rebinding.
const OUTPUT_HOST = "file.aiquickdraw.com";

class SunoApiError extends Error {}

export function createSunoApiHttp(apiKey: string, injected?: typeof fetch) {
  const fail = (message: string): Error => {
    const error = new SunoApiError(`SunoAPI.org third-party audio service: ${message}`);
    if (typeof apiKey === "string" && apiKey.length) {
      error.message = error.message.split(apiKey).join("[REDACTED]");
      if (error.stack) error.stack = error.stack.split(apiKey).join("[REDACTED]");
    }
    return error;
  };
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(apiKey)) {
    throw fail("a valid saved API key is required.");
  }
  const active = (signal: AbortSignal): void => {
    if (!signal.aborted) return;
    const error = fail("request cancelled; the remote task may still complete.");
    error.name = "AbortError";
    throw error;
  };
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw fail("invalid protocol response.");
    }
    return value as Record<string, unknown>;
  };
  const identifier = (value: unknown): string => {
    // The schema specifies opaque strings, not UUIDs. Restrict the characters
    // crossing the persisted locator boundary without assuming a UUID version.
    if (typeof value !== "string" || !/^[a-z0-9_-]{1,128}$/iu.test(value) ||
        value.toLowerCase().includes(apiKey.toLowerCase())) {
      throw fail("invalid or credential-bearing task/audio identifier.");
    }
    return value;
  };
  const checkedUrl = (value: unknown, callback: boolean): string => {
    if (typeof value !== "string" || value.length > 2048 || /[\s\\]/u.test(value)) {
      throw fail(callback ? "invalid callback URL." : "invalid output URL.");
    }
    let url: URL;
    try {
      url = new URL(value);
      const decoded = decodeURIComponent(value);
      if (decoded.toLowerCase().includes(apiKey.toLowerCase()) || /[\s\\\u0000-\u001f\u007f]/u.test(decoded)) {
        throw new Error();
      }
    } catch {
      throw fail(callback ? "invalid or credential-bearing callback URL." : "invalid or credential-bearing output URL.");
    }
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
        (callback && (value.includes("?") || value.includes("#")))) {
      throw fail(callback ? "callback must be a public HTTPS URL without credentials, port, query or fragment." : "untrusted output URL.");
    }
    if (callback) {
      // This is a user-configured endpoint, never an agent-controlled URL. The
      // owner supplies its public address; the client does not fetch it or claim
      // that syntax validation establishes DNS reachability or ownership.
      const authority = value.split("/")[2];
      const host = url.hostname.toLowerCase().replace(/\.$/u, "");
      const labels = host.split(".");
      if (!/^https:\/\//iu.test(value) || !authority || authority.includes("@") ||
          isIP(host) || host.length > 253 || labels.length < 2 ||
          !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ||
          /(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion|lan|corp|home)$/u.test(host) ||
          /(?:^|\.)home\.arpa$/u.test(host)) {
        throw fail("callback must use a public HTTPS hostname.");
      }
    } else if (url.hostname !== OUTPUT_HOST || !value.startsWith(`https://${OUTPUT_HOST}/`) || url.pathname === "/") {
      throw fail("output host is not a documented, allowed SunoAPI.org audio CDN.");
    }
    return url.href;
  };

  const request = async (
    url: string, init: RequestInit, signal: AbortSignal, maximumBytes: number, preserveReceipt = false,
  ): Promise<Uint8Array> => {
    active(signal);
    const controller = createHostAbortController();
    let timedOut = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (preserveReceipt) stopTimer = setTimeout(() => controller.abort(), SUBMIT_STOP_GRACE_MS);
      else controller.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
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
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw fail("invalid HTTP response status.");
      if (response.status !== 200) throw fail(`request failed (HTTP ${response.status}).`);
      const mime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (maximumBytes === MAX_JSON_BYTES ? mime !== "application/json" :
          !["audio/mpeg", "audio/wav", "audio/x-wav", "application/octet-stream"].includes(mime ?? "")) {
        throw fail("unexpected response media type.");
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
      if (error instanceof SunoApiError) throw error;
      throw fail("request or response read failed; its remote outcome may be unknown.");
    } finally {
      clearTimeout(timer);
      clearTimeout(stopTimer);
      signal.removeEventListener("abort", onAbort);
    }
  };
  const json = async (signal: AbortSignal, body?: Record<string, unknown>, taskId?: string): Promise<Record<string, unknown>> => {
    const submit = body !== undefined;
    const bytes = await request(submit ? API_BASE : `${API_BASE}/record-info?taskId=${encodeURIComponent(identifier(taskId))}`, {
      method: submit ? "POST" : "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json", ...(submit ? { "Content-Type": "application/json" } : {}) },
      ...(submit ? { body: JSON.stringify(body) } : {}),
    }, signal, MAX_JSON_BYTES, submit);
    if (!submit) active(signal);
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      validateJson(parsed);
      value = object(parsed);
    } catch {
      throw fail("invalid JSON response.");
    }
    if (!Number.isSafeInteger(value.code) || typeof value.msg !== "string") throw fail("invalid response envelope.");
    if (value.code !== 200) throw fail("provider rejected the request; no automatic retry was attempted.");
    return object(value.data);
  };
  return {
    fail, active, object, identifier,
    callbackUrl: (value: unknown) => checkedUrl(value, true),
    outputUrl: (value: unknown) => checkedUrl(value, false),
    post: (body: Record<string, unknown>, signal: AbortSignal) => json(signal, body),
    inspect: (taskId: string, signal: AbortSignal) => json(signal, undefined, taskId),
    download: (url: string, signal: AbortSignal) => request(checkedUrl(url, false), {
      method: "GET", headers: { Accept: "audio/mpeg, audio/wav, application/octet-stream" },
    }, signal, MAX_AUDIO_ASSET_BYTES),
  };
}

function validateJson(value: unknown): void {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > 4096 || entry.depth > 16) throw new Error();
    if (typeof entry.value === "number" && !Number.isFinite(entry.value)) throw new Error();
    if (!entry.value || typeof entry.value !== "object") continue;
    for (const [key, child] of Object.entries(entry.value)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error();
      pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
}
