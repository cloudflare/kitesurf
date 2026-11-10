// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Owns the package's captured HTTP intrinsics. The privileged transport stamps headers and
// releases opaque responses after page code has run, so every request/response read or write on
// that path uses these captures instead of a page-mutable global or prototype.

import { ksGlobal } from "./state.ts";

// Captured before page scripts run; installRequestShim() replaces the public Request later.
export const nativeApply = Reflect.apply;
const nativeConstruct = Reflect.construct;
const nativeDefineProperty = Object.defineProperty;
const nativeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const nativeGetPrototypeOf = Object.getPrototypeOf;
const nativeCreate = Object.create;
const nativeOwnKeys = Reflect.ownKeys;
const nativeReflectGet = Reflect.get;
const nativeObject = Object;
const NativePromise: PromiseConstructor = ksGlobal.Promise;
export const NativeUint8Array: Uint8ArrayConstructor = ksGlobal.Uint8Array;

const NativeHeaders: typeof Headers | undefined = ksGlobal.Headers;
const headersProto: Headers | undefined = NativeHeaders?.prototype;
const nativeGet = headersProto?.get;
const nativeSet = headersProto?.set;
const nativeHas = headersProto?.has;
const nativeDelete = headersProto?.delete;
const nativeAppend = headersProto?.append;
const nativeEntries = headersProto?.entries;

const NativeRequest: typeof Request | undefined = ksGlobal.Request;
const requestProto: Request | undefined = NativeRequest?.prototype;
const responseProto: Response | undefined = ksGlobal.Response?.prototype;

type NativeGetter = (this: unknown) => unknown;
type NativeMethod = (this: unknown, ...args: unknown[]) => unknown;

// Body and header accessors live on shared mixin prototypes in some runtimes, so look up the
// nearest own descriptor along the native chain instead of assuming Request.prototype owns it.
function findDescriptor(proto: object | undefined, name: string): PropertyDescriptor | undefined {
  const MAX_PROTOTYPE_DEPTH = 8;
  let current = proto;
  for (let depth = 0; current && depth < MAX_PROTOTYPE_DEPTH; depth++) {
    const descriptor = nativeGetOwnPropertyDescriptor(current, name);
    if (descriptor) return descriptor;
    current = nativeGetPrototypeOf(current) as object | undefined;
  }
  return undefined;
}

function protoGetter(proto: object | undefined, name: string): NativeGetter | undefined {
  if (!proto) return undefined;
  const descriptor = findDescriptor(proto, name);
  return typeof descriptor?.get === "function" ? descriptor.get : undefined;
}

function protoMethod(proto: object | undefined, name: string): NativeMethod | undefined {
  if (!proto) return undefined;
  const descriptor = findDescriptor(proto, name);
  return typeof descriptor?.value === "function" ? descriptor.value : undefined;
}

const nativeRequestHeaders = protoGetter(requestProto, "headers");
const nativeRequestUrl = protoGetter(requestProto, "url");
const nativeRequestMethod = protoGetter(requestProto, "method");
const nativeRequestRedirect = protoGetter(requestProto, "redirect");
const nativeRequestCache = protoGetter(requestProto, "cache");
const nativeRequestBody = protoGetter(requestProto, "body");
const nativeRequestSignal = protoGetter(requestProto, "signal");
const nativeRequestArrayBuffer = protoMethod(requestProto, "arrayBuffer");

const nativeResponseUrl = protoGetter(responseProto, "url");
const nativeResponseOk = protoGetter(responseProto, "ok");
const nativeResponseHeaders = protoGetter(responseProto, "headers");
const nativeResponseArrayBuffer = protoMethod(responseProto, "arrayBuffer");

// The Headers iterator prototype is not reachable by name; take `next` from a probe iterator.
const nativeHeadersNext = (() => {
  if (!NativeHeaders || !nativeEntries) return undefined;
  try {
    const iterator = nativeApply(nativeEntries, new NativeHeaders(), []) as {
      next?: unknown;
    };
    return typeof iterator.next === "function" ? (iterator.next as NativeMethod) : undefined;
  } catch {
    return undefined;
  }
})();

const nativeResponseStatus = protoGetter(responseProto, "status");
const nativeResponseBody = protoGetter(responseProto, "body");
const nativeResponseText = protoMethod(responseProto, "text");
const nativeStreamCancel = protoMethod(
  typeof ReadableStream === "function" ? ReadableStream.prototype : undefined,
  "cancel",
);

// A missing capture must fail closed: skipping a stamped header or a body read can change
// authentication, policy, or which bytes the page observes.
function requireIntrinsic<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new TypeError(`kitesurf: native ${name} is unavailable`);
  }
  return value;
}

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

/** Native header pairs in iteration order, as own data properties of a fresh array. */
export function hdrEntries(headers: Headers | null): Array<[string, string]> {
  if (!headers) return [];
  const entries = requireIntrinsic(nativeEntries, "Headers.prototype.entries");
  const next = requireIntrinsic(nativeHeadersNext, "Headers iterator next");
  const iterator = nativeApply(entries, headers, []);
  const rows: Array<[string, string]> = [];
  let index = 0;
  for (;;) {
    const step = nativeApply(next, iterator, []) as IteratorResult<[string, string]>;
    if (step.done) break;
    nativeDefineProperty(rows, index, {
      value: step.value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    index += 1;
  }
  return rows;
}

export function newNativeRequest(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
): Request {
  const ctor = requireIntrinsic(NativeRequest, "Request");
  return nativeConstruct(ctor, [input, init]) as Request;
}

export function requestHeaders(request: Request): Headers {
  const getter = requireIntrinsic(nativeRequestHeaders, "Request.prototype.headers");
  return nativeApply(getter, request, []) as Headers;
}

export function requestUrl(request: Request): string {
  const getter = requireIntrinsic(nativeRequestUrl, "Request.prototype.url");
  return nativeApply(getter, request, []) as string;
}

export function requestMethod(request: Request): string {
  const getter = requireIntrinsic(nativeRequestMethod, "Request.prototype.method");
  return nativeApply(getter, request, []) as string;
}

export function requestRedirect(request: Request): string {
  const getter = requireIntrinsic(nativeRequestRedirect, "Request.prototype.redirect");
  return nativeApply(getter, request, []) as string;
}

export function requestCache(request: Request): string {
  const getter = requireIntrinsic(nativeRequestCache, "Request.prototype.cache");
  return nativeApply(getter, request, []) as string;
}

export function requestBody(request: Request): ReadableStream<Uint8Array> | null {
  const getter = requireIntrinsic(nativeRequestBody, "Request.prototype.body");
  return nativeApply(getter, request, []) as ReadableStream<Uint8Array> | null;
}

export function requestSignal(request: Request): AbortSignal | null {
  const getter = requireIntrinsic(nativeRequestSignal, "Request.prototype.signal");
  return nativeApply(getter, request, []) as AbortSignal | null;
}

export function requestArrayBuffer(request: Request): Promise<ArrayBuffer> {
  const method = requireIntrinsic(nativeRequestArrayBuffer, "Request.prototype.arrayBuffer");
  return nativeApply(method, request, []) as Promise<ArrayBuffer>;
}

export function responseOk(response: Response): boolean {
  const getter = requireIntrinsic(nativeResponseOk, "Response.prototype.ok");
  return nativeApply(getter, response, []) as boolean;
}

export function responseArrayBuffer(response: Response): Promise<ArrayBuffer> {
  const method = requireIntrinsic(nativeResponseArrayBuffer, "Response.prototype.arrayBuffer");
  return nativeApply(method, response, []) as Promise<ArrayBuffer>;
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

/** Defines an own property through the captured intrinsic, so no inherited setter runs. */
export function defineOwn(target: object, key: PropertyKey, descriptor: PropertyDescriptor): void {
  nativeDefineProperty(target, key, descriptor);
}

export function newNativePromise<T>(
  executor: (
    resolve: (value: T | PromiseLike<T>) => void,
    reject: (reason?: unknown) => void,
  ) => void,
): Promise<T> {
  return new NativePromise<T>(executor);
}

/** Copies own enumerable properties (getters included) onto a null-prototype object. */
export function copyOwnEnumerable<T extends object>(source: object | null | undefined): T {
  const target = nativeCreate(null) as T;
  if (source === null || source === undefined) return target;
  const from: object = nativeObject(source);
  const keys = nativeOwnKeys(from);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const descriptor = nativeGetOwnPropertyDescriptor(from, key);
    if (!descriptor || descriptor.enumerable !== true) continue;
    nativeDefineProperty(target, key, {
      value: nativeReflectGet(from, key),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return target;
}
