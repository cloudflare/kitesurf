// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Routes page and dedicated-worker fetches through the session-owned engine stub.

import type { SessionOutbound, SessionOutboundRequest } from "@kitesurf/jsrpc-types/page-script";
import {
  cancelResponseBody,
  controllerClose,
  controllerEnqueue,
  controllerError,
  defineOwn,
  hdrEntries,
  hdrGet,
  hdrHas,
  hdrSet,
  newHeaders,
  newNativePromise,
  newNativeReadableStream,
  newNativeRequest,
  newNativeResponseLike,
  readerCancel,
  readerRead,
  requestArrayBuffer,
  requestBody,
  requestCache,
  requestHeaders,
  requestMethod,
  requestRedirect,
  requestSignal,
  requestUrl,
  responseBody,
  responseHeaders,
  responseUrl,
  streamGetReader,
} from "./native-http.ts";

export type OutboundStub = Rpc.Stub<SessionOutbound>;

// Only the call signature is used here; the caller keeps the stub for disposal.
let outbound: SessionOutbound | null = null;

export function setSessionOutbound(stub: SessionOutbound): void {
  outbound = stub;
}

export function clearSessionOutbound(stub: SessionOutbound): void {
  if (outbound === stub) outbound = null;
}

const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);

interface LiveBody {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  controller: ReadableStreamDefaultController<Uint8Array>;
  // Unlinks the entry and removes its abort listener; this body can no longer stream.
  release(): void;
  prev: LiveBody | null;
  next: LiveBody | null;
}

// A routed body keeps this isolate alive until it ends, and a locked body can only be cancelled
// through its reader, so this module holds every routed body's reader. Opaque responses are
// among them, so the registry is a plain linked list: a collection's methods would hand entries
// to a page-patched prototype.
let liveBodies: LiveBody | null = null;

function linkLiveBody(entry: LiveBody): void {
  entry.next = liveBodies;
  if (liveBodies) liveBodies.prev = entry;
  liveBodies = entry;
}

function unlinkLiveBody(entry: LiveBody): void {
  if (entry.prev) entry.prev.next = entry.next;
  else if (liveBodies === entry) liveBodies = entry.next;
  if (entry.next) entry.next.prev = entry.prev;
  entry.prev = null;
  entry.next = null;
}

function endLiveBody(entry: LiveBody, reason: unknown): void {
  entry.release();
  try {
    controllerError(entry.controller, reason);
  } catch {}
  try {
    readerCancel(entry.reader, reason);
  } catch {}
}

/** Ends every routed body still open when the page session closes. */
export function cancelSessionResponseBodies(): void {
  const reason = new DOMException("The operation was aborted.", "AbortError");
  while (liveBodies) endLiveBody(liveBodies, reason);
}

function isWebSocketUpgrade(request: Request): boolean {
  return (hdrGet(requestHeaders(request), "upgrade") ?? "").toLowerCase() === "websocket";
}

function isNetworkUrl(request: Request): boolean {
  return /^https?:/i.test(requestUrl(request));
}

// A cache mode adds these headers as the browser's own; the mark names the ones it added, so
// CORS does not count them as the page's. A value the page set stays the page's.
function applyCacheMode(headers: Headers, cache: string): void {
  const added: string[] = [];
  const add = (name: string, value: string): void => {
    if (hdrHas(headers, name)) return;
    hdrSet(headers, name, value);
    added.push(name);
  };
  if (cache === "no-store") {
    add("pragma", "no-cache");
    add("cache-control", "no-cache");
  } else if (cache === "no-cache") {
    add("cache-control", "max-age=0");
  }
  if (added.length > 0) hdrSet(headers, "x-kitesurf-cache-mode", added.join(","));
}

function withRequestUrl(response: Response, url: string): void {
  // Captured accessors only: a redirect shell still carries its Location and must never
  // reach a page-installed getter.
  if (responseUrl(response)) return;
  const hash = url.indexOf("#");
  const value = hash === -1 ? url : url.slice(0, hash);
  try {
    defineOwn(response, "url", { value, configurable: true, enumerable: true });
  } catch {}
}

function immutableHeadersError(): never {
  throw new TypeError("Can't modify immutable headers.");
}

const IMMUTABLE_HEADER_METHODS = ["append", "set", "delete"];

function freezeHeaders(response: Response): void {
  const headers = responseHeaders(response);
  if (!headers) throw new TypeError("kitesurf: response headers are unavailable");
  for (let i = 0; i < IMMUTABLE_HEADER_METHODS.length; i++) {
    defineOwn(headers, IMMUTABLE_HEADER_METHODS[i], {
      value: immutableHeadersError,
      configurable: true,
    });
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

// Mirrors a routed response body into one the page can read while this module keeps the
// source's reader, so session close and aborts end the source through that reader.
function ownBody(response: Response, signal: AbortSignal | null): Response {
  const body = responseBody(response);
  if (body === null) return response;

  const reader = streamGetReader(body);
  let live: LiveBody | null = null;

  const onAbort = (): void => {
    if (live && signal) endLiveBody(live, abortError(signal));
  };
  const detach = (): void => {
    if (signal) signal.removeEventListener("abort", onAbort);
  };
  // This body can no longer stream, so it needs neither the source nor the abort listener.
  const release = (): void => {
    if (!live) return;
    unlinkLiveBody(live);
    detach();
    live = null;
  };

  const wrapped = newNativeReadableStream<Uint8Array>({
    start(controller) {
      live = { reader, controller, release, prev: null, next: null };
      linkLiveBody(live);
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      try {
        const result = await readerRead(reader);
        if (!live) return; // session close or an abort ended this body while reading
        if (result.done) {
          release();
          controllerClose(controller);
          return;
        }
        controllerEnqueue(controller, result.value);
      } catch (error) {
        if (!live) return;
        release();
        controllerError(controller, error);
      }
    },
    cancel(reason) {
      release();
      readerCancel(reader, reason);
    },
  });

  return newNativeResponseLike(wrapped, response);
}

/** Routes eligible HTTP(S) fetches through the session stub; WebSocket upgrades bypass it.
 * Followed redirects use native fetch. The returned body is owned here so session close and
 * aborts can end it; an abort rejects locally, and a late response's body is cancelled.
 */
export function routeViaSession(native: typeof globalThis.fetch): typeof globalThis.fetch {
  return async function fetch(input, init) {
    const stub = outbound;
    if (!stub) return native(input, init);
    const request = newNativeRequest(input, init);
    const method = requestMethod(request);
    if (FORBIDDEN_METHODS.has(method.toUpperCase())) {
      throw new TypeError(`Failed to construct 'Request': '${method}' HTTP method is unsupported.`);
    }
    if (
      !isNetworkUrl(request) ||
      isWebSocketUpgrade(request) ||
      requestRedirect(request) === "follow"
    ) {
      return native(input, init);
    }
    const signal = init?.signal ?? requestSignal(request);
    if (signal?.aborted) throw abortError(signal);
    const headers = newHeaders(requestHeaders(request));
    applyCacheMode(headers, requestCache(request));
    const bodyStream = requestBody(request);
    let body: SessionOutboundRequest["body"] = null;
    if (bodyStream) {
      body = init?.body instanceof ReadableStream ? bodyStream : await requestArrayBuffer(request);
    }
    const url = requestUrl(request);
    // Keep egress on the engine stub rather than opening sockets in the loaded worker. The
    // continuation is private: the page must not receive the promise or the response it holds.
    let aborted = false;
    const call = (async (): Promise<Response> => {
      const response = await stub({
        url,
        method,
        headers: hdrEntries(headers),
        body,
      });
      // The caller already rejected on the abort, so its body is cancelled unwrapped below.
      if (aborted) return response;
      const owned = ownBody(response, signal);
      withRequestUrl(owned, url);
      freezeHeaders(owned);
      return owned;
    })();
    if (!signal) return await call;
    return await newNativePromise<Response>((resolve, reject) => {
      const onAbort = (): void => {
        aborted = true;
        reject(abortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        signal.removeEventListener("abort", onAbort);
        onAbort();
      }
      void (async (): Promise<void> => {
        try {
          const response = await call;
          signal.removeEventListener("abort", onAbort);
          if (aborted) {
            // The page-facing promise already rejected, so no reader is left for this body.
            cancelResponseBody(response);
            return;
          }
          resolve(response);
        } catch (error) {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      })();
    });
  } as typeof globalThis.fetch;
}
