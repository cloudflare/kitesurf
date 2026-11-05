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

/** Routes eligible HTTP(S) fetches through the session stub; WebSocket upgrades bypass it.
 * Followed redirects use native fetch; routed aborts reject locally without canceling engine work.
 */
export function routeViaSession(native: typeof globalThis.fetch): typeof globalThis.fetch {
  return async function fetch(input, init) {
    const stub = outbound;
    if (!stub) return native(input, init);
    const request = new Request(input, init);
    if (!isNetworkUrl(request) || isWebSocketUpgrade(request) || request.redirect === "follow") {
      return native(input, init);
    }
    const signal = init?.signal ?? request.signal;
    if (signal?.aborted) throw abortError(signal);
    const headers = newHeaders(request.headers);
    applyCacheMode(headers, (request as { cache?: string }).cache ?? "");
    let body: SessionOutboundRequest["body"] = null;
    if (request.body) {
      body = init?.body instanceof ReadableStream ? request.body : await request.arrayBuffer();
    }
    // Keep egress on the engine stub rather than opening sockets in the loaded worker.
    const call = stub({
      url: request.url,
      method: request.method,
      headers: hdrEntries(headers),
      body,
    }).then((response) => {
      withRequestUrl(response, request.url);
      freezeHeaders(response);
      return response;
    });
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
  } as typeof globalThis.fetch;
}
