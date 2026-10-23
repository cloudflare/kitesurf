// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Routes page and dedicated-worker fetches through the session-owned engine stub.

import type { SessionOutbound, SessionOutboundRequest } from "@kitesurf/jsrpc-types/page-script";
import { hdrEntries, hdrHas, hdrSet, newHeaders } from "./native-http.ts";

export type OutboundStub = Rpc.Stub<SessionOutbound>;

let outbound: OutboundStub | null = null;

export function setSessionOutbound(stub: OutboundStub): void {
  outbound = stub;
}

export function clearSessionOutbound(stub: OutboundStub): void {
  if (outbound === stub) outbound = null;
}

function isWebSocketUpgrade(request: Request): boolean {
  return (request.headers.get("upgrade") ?? "").toLowerCase() === "websocket";
}

function isNetworkUrl(request: Request): boolean {
  return /^https?:/i.test(request.url);
}

function applyCacheMode(headers: Headers, cache: string): void {
  if (cache === "no-store") {
    applyNoStoreCacheMode(headers);
    return;
  }
  if (cache === "no-cache") applyNoCacheMode(headers);
}

function applyNoStoreCacheMode(headers: Headers): void {
  if (!hdrHas(headers, "pragma")) hdrSet(headers, "pragma", "no-cache");
  if (!hdrHas(headers, "cache-control")) hdrSet(headers, "cache-control", "no-cache");
}

function applyNoCacheMode(headers: Headers): void {
  if (!hdrHas(headers, "cache-control")) hdrSet(headers, "cache-control", "max-age=0");
}

function withRequestUrl(response: Response, url: string): void {
  if (response.url) return;
  const hash = url.indexOf("#");
  const value = hash === -1 ? url : url.slice(0, hash);
  try {
    Object.defineProperty(response, "url", { value, configurable: true, enumerable: true });
  } catch {}
}

function immutableHeadersError(): never {
  throw new TypeError("Can't modify immutable headers.");
}

function freezeHeaders(response: Response): void {
  const headers = response.headers;
  for (const name of ["append", "set", "delete"]) {
    Object.defineProperty(headers, name, {
      value: immutableHeadersError,
      configurable: true,
    });
  }
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

type FetchArgs = Parameters<typeof globalThis.fetch>;

function isRoutedRequest(request: Request): boolean {
  return isNetworkUrl(request) && !isWebSocketUpgrade(request) && request.redirect !== "follow";
}

function requestSignal(init: FetchArgs[1], request: Request): AbortSignal | null {
  return init?.signal ?? request.signal;
}

function throwIfAborted(signal: AbortSignal | null): void {
  if (signal?.aborted) throw abortError(signal);
}

function sessionRequest(
  stub: OutboundStub,
  request: Request,
  headers: Headers,
  body: SessionOutboundRequest["body"],
): Promise<Response> {
  return stub({
    url: request.url,
    method: request.method,
    headers: hdrEntries(headers),
    body,
  }).then((response) => {
    withRequestUrl(response, request.url);
    freezeHeaders(response);
    return response;
  });
}

async function waitForSessionResponse(
  call: Promise<Response>,
  signal: AbortSignal | null,
): Promise<Response> {
  if (!signal) return await call;
  return await new Promise<Response>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    call.then(
      (response) => {
        signal.removeEventListener("abort", onAbort);
        resolve(response);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function routeSessionRequest(
  stub: OutboundStub,
  request: Request,
  init: FetchArgs[1],
  signal: AbortSignal | null,
): Promise<Response> {
  const headers = newHeaders(request.headers);
  applyCacheMode(headers, (request as { cache?: string }).cache ?? "");
  // Only body buffering may yield before abort handling is registered.
  let body: SessionOutboundRequest["body"] = null;
  if (request.body) {
    body = init?.body instanceof ReadableStream ? request.body : await request.arrayBuffer();
  }
  const call = sessionRequest(stub, request, headers, body);
  return waitForSessionResponse(call, signal);
}

async function routeRequest(
  native: typeof globalThis.fetch,
  input: FetchArgs[0],
  init: FetchArgs[1],
): Promise<Response> {
  const stub = outbound;
  if (!stub) return native(input, init);
  const request = new Request(input, init);
  if (!isRoutedRequest(request)) return native(input, init);
  const signal = requestSignal(init, request);
  throwIfAborted(signal);
  return routeSessionRequest(stub, request, init, signal);
}

/** Routes eligible HTTP(S) fetches through the session stub; WebSocket upgrades bypass it.
 * Followed redirects use native fetch; routed aborts reject locally without canceling engine work.
 */
export function routeViaSession(native: typeof globalThis.fetch): typeof globalThis.fetch {
  return async function fetch(input, init) {
    // Keep egress on the engine stub rather than opening sockets in the loaded worker.
    return routeRequest(native, input, init);
  } as typeof globalThis.fetch;
}
