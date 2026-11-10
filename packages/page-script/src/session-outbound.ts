// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Routes page and dedicated-worker fetches through the session-owned engine stub.

import type { SessionOutbound, SessionOutboundRequest } from "@kitesurf/jsrpc-types/page-script";
import {
  cancelResponseBody,
  defineOwn,
  hdrEntries,
  hdrGet,
  hdrHas,
  hdrSet,
  newHeaders,
  newNativePromise,
  newNativeRequest,
  requestArrayBuffer,
  requestBody,
  requestCache,
  requestHeaders,
  requestMethod,
  requestRedirect,
  requestSignal,
  requestUrl,
  responseHeaders,
  responseUrl,
} from "./native-http.ts";

export type OutboundStub = Rpc.Stub<SessionOutbound>;

let outbound: OutboundStub | null = null;

export function setSessionOutbound(stub: OutboundStub): void {
  outbound = stub;
}

export function clearSessionOutbound(stub: OutboundStub): void {
  if (outbound === stub) outbound = null;
}

const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);

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

/** Routes eligible HTTP(S) fetches through the session stub; WebSocket upgrades bypass it.
 * Followed redirects use native fetch; routed aborts reject locally without canceling engine work.
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
    const call = (async (): Promise<Response> => {
      const response = await stub({
        url,
        method,
        headers: hdrEntries(headers),
        body,
      });
      withRequestUrl(response, url);
      freezeHeaders(response);
      return response;
    })();
    if (!signal) return await call;
    return await newNativePromise<Response>((resolve, reject) => {
      const onAbort = (): void => reject(abortError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      void (async (): Promise<void> => {
        try {
          const response = await call;
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) {
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
