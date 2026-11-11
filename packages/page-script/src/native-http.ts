// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Provides fetch header helpers backed by captured native Headers and Response methods.

import { ksGlobal } from "./state.ts";

// Capture these intrinsics before page scripts can replace Headers methods.
const nativeApply = Reflect.apply;

const NativeHeaders: typeof Headers | undefined = ksGlobal.Headers;
const headersProto: Headers | undefined = NativeHeaders?.prototype;
const nativeGet = headersProto?.get;
const nativeSet = headersProto?.set;
const nativeHas = headersProto?.has;
const nativeDelete = headersProto?.delete;
const nativeAppend = headersProto?.append;
const nativeEntries = headersProto?.entries;
const nativeResponseHeaders = (() => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis.Response?.prototype ?? {},
      "headers",
    );
    return typeof descriptor?.get === "function" ? descriptor.get : undefined;
  } catch {
    return undefined;
  }
})();

const nativeResponseStatus = (() => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis.Response?.prototype ?? {},
      "status",
    );
    return typeof descriptor?.get === "function" ? descriptor.get : undefined;
  } catch {
    return undefined;
  }
})();

const nativeResponseUrl = (() => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis.Response?.prototype ?? {}, "url");
    return typeof descriptor?.get === "function" ? descriptor.get : undefined;
  } catch {
    return undefined;
  }
})();

const nativeResponseBody = (() => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis.Response?.prototype ?? {},
      "body",
    );
    return typeof descriptor?.get === "function" ? descriptor.get : undefined;
  } catch {
    return undefined;
  }
})();

const nativeResponseText = (() => {
  try {
    const text = globalThis.Response?.prototype?.text;
    return typeof text === "function" ? text : undefined;
  } catch {
    return undefined;
  }
})();

const nativeStreamCancel = (() => {
  try {
    if (typeof ReadableStream !== "function") return undefined;
    const cancel = ReadableStream.prototype.cancel;
    return typeof cancel === "function" ? cancel : undefined;
  } catch {
    return undefined;
  }
})();

type HeadersArg = ConstructorParameters<typeof Headers>[0];

export function newHeaders(init?: HeadersArg): Headers {
  return NativeHeaders ? new NativeHeaders(init) : new Headers(init);
}

export function hdrGet(headers: Headers | null, name: string): string | null {
  if (!headers) return null;
  try {
    return nativeGet ? nativeApply(nativeGet, headers, [name]) : headers.get(name);
  } catch {
    return null;
  }
}

export function hdrHas(headers: Headers, name: string): boolean {
  try {
    return nativeHas ? nativeApply(nativeHas, headers, [name]) : headers.has(name);
  } catch {
    return false;
  }
}

export function hdrSet(headers: Headers, name: string, value: string): void {
  // Engine-owned carriers bypass page-facing filters through these captured methods.
  try {
    if (nativeSet) nativeApply(nativeSet, headers, [name, value]);
    else headers.set(name, value);
  } catch {
    // Omit an invalid carrier rather than failing the request; absent hints are conservative.
  }
}

export function hdrAppend(headers: Headers, name: string, value: string): void {
  try {
    if (nativeAppend) nativeApply(nativeAppend, headers, [name, value]);
    else headers.append(name, value);
  } catch {}
}

export function hdrDelete(headers: Headers, name: string): void {
  try {
    if (nativeDelete) nativeApply(nativeDelete, headers, [name]);
    else headers.delete(name);
  } catch {}
}

export function hdrEntries(headers: Headers | null): Array<[string, string]> {
  if (!headers) return [];
  try {
    const entries = nativeEntries ? nativeApply(nativeEntries, headers, []) : headers.entries();
    return Array.from(entries) as Array<[string, string]>;
  } catch {
    return [];
  }
}

export function responseHeaders(response: Response | null): Headers | null {
  if (!response) return null;
  try {
    const headers = nativeResponseHeaders
      ? (nativeApply(nativeResponseHeaders, response, []) as Headers)
      : response.headers;
    return headers ?? null;
  } catch {
    return null;
  }
}

export function responseHeaderGet(response: Response | null, name: string): string | null {
  return hdrGet(responseHeaders(response), name);
}

// Status, url and body reads never fall back to the page-replaceable property: an engine
// response may still carry a cross-origin Location the page must not observe, and a
// page-installed getter would run with that response as its receiver. A missing capture
// fails the fetch closed instead.
function nativeResponseRead<T>(getter: (() => unknown) | undefined, response: Response): T {
  if (!getter) throw new TypeError("Failed to fetch");
  try {
    return nativeApply(getter, response, []) as T;
  } catch {
    throw new TypeError("Failed to fetch");
  }
}

export function responseStatus(response: Response): number {
  return nativeResponseRead<number>(nativeResponseStatus, response);
}

export function responseUrl(response: Response): string {
  return String(nativeResponseRead<string | null>(nativeResponseUrl, response) ?? "");
}

export async function responseText(response: Response): Promise<string> {
  if (!nativeResponseText) throw new TypeError("Failed to fetch");
  return (await nativeApply(nativeResponseText, response, [])) as string;
}

/** Drop an engine response's body without handing it to a page callback. */
export function cancelResponseBody(response: Response): void {
  try {
    if (!nativeResponseBody || !nativeStreamCancel) return;
    const body: unknown = nativeApply(nativeResponseBody, response, []);
    if (!body) return;
    const cancelled = nativeApply(nativeStreamCancel, body, []) as Promise<void> | undefined;
    if (cancelled && typeof cancelled.catch === "function") void cancelled.catch(() => {});
  } catch {}
}
