// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Wraps page fetch with gateway metadata, request validation, redirects, and response handling.

import { isDisallowedError } from "./defer-shim.ts";
import {
  cancelResponseBody,
  copyOwnEnumerable,
  defineOwn,
  hdrAppend,
  hdrDelete,
  hdrEntries,
  hdrGet,
  hdrHas,
  hdrSet,
  newHeaders,
  newResponse,
  responseHeaderGet,
  responseHeaders,
  responseStatus,
  responseText,
} from "./native-http.ts";
import { ksGlobal, ksGlobalByKey, state } from "./state.ts";
import { takeTrustedRequestMeta } from "./trusted-fetch.ts";
import { routeViaSession } from "./session-outbound.ts";
import { serializeMimeType, setBlobMimeType } from "./mime-type.ts";

// Capture before page code can replace Reflect.apply.
// Iterator calls keep the page-supplied method's receiver.
const nativeReflectApply = Reflect.apply;

export function pageOriginFromUrl(href: string): string {
  if (!href) return "";
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (!url.host) return "";
    return url.protocol + "//" + url.host;
  } catch {
    return "";
  }
}

const METHOD_OVERRIDE_HEADERS = new Set([
  "x-http-method",
  "x-http-method-override",
  "x-method-override",
]);

const FETCH_FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);

function valueHasForbiddenMethod(value: string): boolean {
  if (typeof value !== "string") return false;
  const parts = value.split(",");
  for (const raw of parts) {
    const tok = raw.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "").toUpperCase();
    if (FETCH_FORBIDDEN_METHODS.has(tok)) return true;
  }
  return false;
}

function shouldDropHeader(name: string, value: string): boolean {
  const lowerName = String(name).toLowerCase();
  if (METHOD_OVERRIDE_HEADERS.has(lowerName) && valueHasForbiddenMethod(value)) {
    return true;
  }
  return false;
}

function toHeaderByteString(value: unknown): string {
  const MAX_HEADER_BYTE_STRING_CODE_POINT = 0xff;
  if (typeof value === "symbol") {
    throw new TypeError("Cannot convert a Symbol value to a string");
  }
  const string = String(value);
  for (let index = 0; index < string.length; index++) {
    if (string.charCodeAt(index) > MAX_HEADER_BYTE_STRING_CODE_POINT) {
      throw new TypeError("Header values must contain only byte code points");
    }
  }
  return string;
}

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isIteratorResult(value: unknown): value is object {
  return isObjectLike(value);
}

// Read page-supplied iterator methods once and validate steps before accessing their fields.
function iterableFromMethod(target: object, method: Function): Iterable<unknown> {
  return {
    [Symbol.iterator]() {
      const iterator: unknown = nativeReflectApply(method, target, []);
      if (!isObjectLike(iterator)) {
        throw new TypeError("Sequence iterator is not an object");
      }
      const nextMethod: unknown = Reflect.get(iterator, "next", iterator);
      if (typeof nextMethod !== "function") {
        throw new TypeError("Sequence iterator next is not callable");
      }
      return {
        next(): IteratorResult<unknown> {
          const step: unknown = nativeReflectApply(nextMethod, iterator, []);
          if (!isIteratorResult(step)) {
            throw new TypeError("Iterator result is not an object");
          }
          const done: unknown = Reflect.get(step, "done", step);
          if (done) {
            return { done: true, value: undefined };
          }
          return { done: false, value: Reflect.get(step, "value", step) };
        },
        return(): IteratorResult<unknown> {
          // IteratorClose calls the source iterator's return with that iterator as receiver.
          const closeMethod: unknown = Reflect.get(iterator, "return", iterator);
          if (closeMethod === undefined || closeMethod === null) {
            return { done: true, value: undefined };
          }
          if (typeof closeMethod !== "function") {
            throw new TypeError("Sequence iterator return is not callable");
          }
          const closed: unknown = nativeReflectApply(closeMethod, iterator, []);
          if (!isIteratorResult(closed)) {
            throw new TypeError("Iterator result is not an object");
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function arrayFromUnknown(value: unknown): unknown[] {
  if (!isObjectLike(value)) {
    throw new TypeError("Sequence value is not iterable");
  }
  const iteratorMethod: unknown = Reflect.get(value, Symbol.iterator, value);
  if (typeof iteratorMethod !== "function") {
    throw new TypeError("Sequence value is not iterable");
  }
  const result: unknown = nativeReflectApply(Array.from, Array, [
    iterableFromMethod(value, iteratorMethod),
  ]);
  if (!Array.isArray(result)) {
    throw new TypeError("Sequence conversion did not return an array");
  }
  const values: unknown[] = result;
  return values;
}

function normalizeHeaderInit(init: unknown): string[][] | null | undefined {
  if (init === null) return null;
  if (init === undefined) return undefined;
  if (!isObjectLike(init)) {
    throw new TypeError("Headers init must be an object");
  }
  const record: object = Object(init);
  const iterator: unknown = Reflect.get(record, Symbol.iterator, init);
  if (typeof iterator === "function") {
    const sequence = iterableFromMethod(record, iterator);
    return Array.from(sequence, (entry) => {
      const pair = arrayFromUnknown(entry);
      if (pair.length !== 2) {
        throw new TypeError("Header sequence entries must contain two values");
      }
      return [toHeaderByteString(pair[0]), toHeaderByteString(pair[1])];
    });
  }

  return Object.keys(record).map((name) => [
    toHeaderByteString(name),
    toHeaderByteString(Reflect.get(record, name, record)),
  ]);
}

function withNormalizedHeaderInit(init: unknown): unknown {
  if (!isObjectLike(init)) return init;
  let headersRead = false;
  let normalizedHeaders: string[][] | null | undefined;
  const source = init;
  const target: object = Object.create(null);
  return new Proxy(target, {
    get(_target, property) {
      if (property === "headers") {
        if (!headersRead) {
          normalizedHeaders = normalizeHeaderInit(Reflect.get(source, property, source));
          headersRead = true;
        }
        return normalizedHeaders;
      }
      const value: unknown = Reflect.get(source, property, source);
      return value;
    },
  });
}

function installHeadersForbiddenFilter(): void {
  const HeadersConstructor = ksGlobal.Headers;
  if (typeof HeadersConstructor !== "function") return;
  const headersPrototype = HeadersConstructor.prototype;
  if (!headersPrototype || (headersPrototype as any).__ksForbiddenFiltered) return;
  const originalAppend = headersPrototype.append;
  const originalSet = headersPrototype.set;
  if (typeof originalAppend !== "function" || typeof originalSet !== "function") return;
  headersPrototype.append = function append(name: string, value: string): void {
    const headerName = toHeaderByteString(name);
    const headerValue = toHeaderByteString(value);
    if (shouldDropHeader(headerName, headerValue)) return;
    return originalAppend.call(this, headerName, headerValue);
  };
  headersPrototype.set = function set(name: string, value: string): void {
    const headerName = toHeaderByteString(name);
    const headerValue = toHeaderByteString(value);
    if (shouldDropHeader(headerName, headerValue)) return;
    return originalSet.call(this, headerName, headerValue);
  };
  (headersPrototype as any).__ksForbiddenFiltered = true;
}

const VALID_CACHE_MODES = new Set([
  "default",
  "no-store",
  "reload",
  "no-cache",
  "force-cache",
  "only-if-cached",
]);

const WORKERD_CACHE_MODES = new Set(["no-store", "no-cache"]);

function validateAndStripCache(init: any, isFetchCall: boolean): any {
  if (!init || typeof init !== "object" || (init as any).cache === undefined) return init;
  const cache = String((init as any).cache);
  if (!VALID_CACHE_MODES.has(cache)) {
    throw new TypeError(
      `Failed to construct 'Request': The provided value '${cache}' is not a valid enum value of type RequestCache.`,
    );
  }
  if (cache === "only-if-cached") {
    if ((init as any).mode !== "same-origin") {
      throw new TypeError(
        "Failed to construct 'Request': 'only-if-cached' can be set only if 'mode' is 'same-origin'.",
      );
    }
    if (isFetchCall) {
      throw new TypeError("Failed to fetch: no cached response for 'only-if-cached' request.");
    }
  }
  if (WORKERD_CACHE_MODES.has(cache)) return init;
  const strippedInit = { ...init };
  delete strippedInit.cache;
  return strippedInit;
}

function installRequestShim(): typeof Request {
  const RealRequest = ksGlobal.Request;
  if (typeof RealRequest !== "function") return RealRequest;
  if ((RealRequest as any).__ksWrapped) return RealRequest;

  function resolveRequestInput(input: any): any {
    if (typeof input === "string") {
      if (state.pageUrl) {
        try {
          return new URL(input, state.pageUrl).toString();
        } catch {
          return input;
        }
      }
      return input;
    }
    if (input instanceof URL) return input.toString();
    return input;
  }

  const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);

  function WrappedRequest(this: any, input: any, init?: any) {
    const resolvedInput = resolveRequestInput(input);
    if (init && typeof init === "object" && typeof (init as any).method === "string") {
      const upper = String((init as any).method).toUpperCase();
      if (FORBIDDEN_METHODS.has(upper)) {
        throw new TypeError(
          `Failed to construct 'Request': '${(init as any).method}' HTTP method is unsupported.`,
        );
      }
    }
    const referrerState = requestReferrerState(input, init);
    // Workerd omits Request.referrer and Request.referrerPolicy.
    // Keep their state beside the native Request object.
    const effectiveInit = withNormalizedHeaderInit(
      serializeFormDataBodyInInit(validateAndStripCache(init, false)),
    );
    const request = new.target
      ? Reflect.construct(RealRequest, [resolvedInput, effectiveInit], new.target)
      : Reflect.construct(RealRequest, [resolvedInput, effectiveInit]);
    requestReferrers.set(request, referrerState);
    return request;
  }
  WrappedRequest.prototype = RealRequest.prototype;
  Object.defineProperty(WrappedRequest, "name", { value: "Request" });
  (WrappedRequest as any).__ksWrapped = true;
  // Through the untyped view: a function constructor over RealRequest.prototype, which
  // TypeScript cannot see as `typeof Request`.
  ksGlobalByKey.Request = WrappedRequest;
  patchFormDataRealmCrossing(RealRequest.prototype);
  patchBodyBlobMimeType(RealRequest.prototype);
  installRequestReferrerAttributes(RealRequest.prototype);
  return ksGlobal.Request;
}

// workerd's Request omits `referrer` and `referrerPolicy`, so the shim keeps them per instance and
// sends a page-unforgeable `x-kitesurf-referrer` carrier with same-origin referrers only.
interface RequestReferrerState {
  // "client", "no-referrer", or a same-origin URL.
  referrer: string;
  policy: string;
}
const requestReferrers = new WeakMap<object, RequestReferrerState>();

const REFERRER_POLICY_VALUES = new Set([
  "",
  "no-referrer",
  "no-referrer-when-downgrade",
  "same-origin",
  "origin",
  "strict-origin",
  "origin-when-cross-origin",
  "strict-origin-when-cross-origin",
  "unsafe-url",
]);

// RequestInit members; any of them present makes `init` non-empty,
// which resets an input Request's referrer to the client default.
const REQUEST_INIT_MEMBERS = [
  "method",
  "headers",
  "body",
  "referrer",
  "referrerPolicy",
  "mode",
  "credentials",
  "cache",
  "redirect",
  "integrity",
  "keepalive",
  "signal",
  "duplex",
  "priority",
  "window",
];

function requestReferrerState(input: unknown, init: unknown): RequestReferrerState {
  const inherited = input && typeof input === "object" ? requestReferrers.get(input) : undefined;
  const next: RequestReferrerState = inherited
    ? { ...inherited }
    : { referrer: "client", policy: "" };
  if (!init || typeof init !== "object") return next;
  const member = (key: string): unknown => Reflect.get(init, key);
  if (REQUEST_INIT_MEMBERS.some((k) => member(k) !== undefined)) {
    next.referrer = "client";
    next.policy = "";
  }
  const referrerInit = member("referrer");
  if (referrerInit !== undefined) {
    const value = String(referrerInit);
    if (value === "") {
      next.referrer = "no-referrer";
    } else {
      let parsed: URL;
      try {
        parsed = new URL(value, state.pageUrl || undefined);
      } catch {
        throw new TypeError(
          `Failed to construct 'Request': Referrer '${value}' is not a valid URL.`,
        );
      }
      let pageOrigin = state.documentOrigin;
      // about:client, or a cross-origin URL, falls back to the client.
      next.referrer =
        parsed.href === "about:client" || parsed.origin !== pageOrigin ? "client" : parsed.href;
    }
  }
  const policyInit = member("referrerPolicy");
  if (policyInit !== undefined) {
    const policy = String(policyInit);
    if (!REFERRER_POLICY_VALUES.has(policy)) {
      throw new TypeError(
        `Failed to construct 'Request': The provided value '${policy}' is not a valid enum value of type ReferrerPolicy.`,
      );
    }
    next.policy = policy;
  }
  return next;
}

function installRequestReferrerAttributes(proto: unknown): void {
  if (!proto || typeof proto !== "object") return;
  if (Object.prototype.hasOwnProperty.call(proto, "referrer")) return;
  Object.defineProperty(proto, "referrer", {
    configurable: true,
    enumerable: true,
    get(this: object) {
      const r = requestReferrers.get(this)?.referrer ?? "client";
      if (r === "no-referrer") return "";
      return r === "client" ? "about:client" : r;
    },
  });
  Object.defineProperty(proto, "referrerPolicy", {
    configurable: true,
    enumerable: true,
    get(this: object) {
      return requestReferrers.get(this)?.policy ?? "";
    },
  });
  const realClone: unknown = Reflect.get(proto, "clone");
  if (typeof realClone === "function") {
    Reflect.set(proto, "clone", function clone(this: object): unknown {
      const copy: unknown = realClone.call(this);
      const s = requestReferrers.get(this);
      if (s && copy && typeof copy === "object") requestReferrers.set(copy, { ...s });
      return copy;
    });
  }
}

function installResponseShim(): void {
  const RealResponse = ksGlobal.Response;
  if (typeof RealResponse !== "function") return;
  if ((RealResponse as any).__ksWrapped) return;

  function WrappedResponse(this: any, body?: any, init?: any) {
    const effectiveBody = body instanceof FormData ? formDataToMultipartBlob(body) : body;
    const effectiveInit = withNormalizedHeaderInit(init);
    if (new.target) {
      return Reflect.construct(RealResponse, [effectiveBody, effectiveInit], new.target);
    }
    return Reflect.construct(RealResponse, [effectiveBody, effectiveInit]);
  }
  WrappedResponse.prototype = RealResponse.prototype;
  for (const propertyName of Object.getOwnPropertyNames(RealResponse)) {
    if (propertyName === "length" || propertyName === "name" || propertyName === "prototype")
      continue;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(RealResponse, propertyName);
      if (descriptor) Object.defineProperty(WrappedResponse, propertyName, descriptor);
    } catch {}
  }
  Object.defineProperty(WrappedResponse, "name", { value: "Response" });
  (WrappedResponse as any).__ksWrapped = true;
  // Through the untyped view: a function constructor over RealResponse.prototype with its
  // statics copied on, which TypeScript cannot see as `typeof Response`.
  ksGlobalByKey.Response = WrappedResponse;
  patchFormDataRealmCrossing(RealResponse.prototype);
  patchBodyBlobMimeType(RealResponse.prototype);
}

function patchBodyBlobMimeType(prototype: object): void {
  if (Reflect.get(prototype, "__ksMimeTypeBlobPatched", prototype)) return;
  const nativeBlob: unknown = Reflect.get(prototype, "blob", prototype);
  if (typeof nativeBlob !== "function") return;
  const headersGetter = Object.getOwnPropertyDescriptor(prototype, "headers")?.get;
  const blob = async function blob(this: Response): Promise<Blob> {
    const headers: unknown =
      typeof headersGetter === "function"
        ? nativeReflectApply(headersGetter, this, [])
        : this.headers;
    if (!(headers instanceof Headers)) {
      throw new TypeError("Body.blob() requires a Request or Response");
    }
    const mimeType = serializeMimeType(hdrGet(headers, "content-type") ?? "");
    const result: unknown = await nativeReflectApply(nativeBlob, this, []);
    if (!(result instanceof Blob)) {
      throw new TypeError("Body.blob() did not return a Blob");
    }
    setBlobMimeType(result, mimeType);
    return result;
  };
  if (
    !Reflect.set(prototype, "blob", blob, prototype) ||
    !Reflect.set(prototype, "__ksMimeTypeBlobPatched", true, prototype)
  ) {
    throw new TypeError("Cannot patch Body.blob()");
  }
}

function patchFormDataRealmCrossing(prototype: any): void {
  if (!prototype || prototype.__ksFdPatched) return;
  const realFormData = prototype.formData;
  if (typeof realFormData !== "function") return;
  prototype.formData = async function formData(this: any) {
    const responseFormData = await realFormData.call(this);
    if (responseFormData instanceof FormData) return responseFormData;
    const pageFormData = new FormData();
    if (responseFormData && typeof responseFormData.entries === "function") {
      for (const [name, value] of responseFormData.entries()) pageFormData.append(name, value);
    }
    return pageFormData;
  };
  prototype.__ksFdPatched = true;
}

type BlobPart = string | Blob;

function formDataToMultipartBlob(formData: FormData): Blob {
  const boundary = "----formdata-kitesurf-" + Math.random().toString(36).slice(2, 18);
  const parts: BlobPart[] = [];
  const dashes = "--";
  const crlf = "\r\n";
  for (const [name, value] of formData as any) {
    let header = dashes + boundary + crlf;
    if (typeof value === "string") {
      header +=
        'Content-Disposition: form-data; name="' + escapeMultipartName(name) + '"' + crlf + crlf;
      parts.push(header);
      parts.push(value);
      parts.push(crlf);
    } else {
      const filename = (value && (value as File).name) || "blob";
      const ctype = (value && (value as Blob).type) || "application/octet-stream";
      header +=
        'Content-Disposition: form-data; name="' +
        escapeMultipartName(name) +
        '"; filename="' +
        escapeMultipartName(filename) +
        '"' +
        crlf +
        "Content-Type: " +
        ctype +
        crlf +
        crlf;
      parts.push(header);
      parts.push(value as Blob);
      parts.push(crlf);
    }
  }
  parts.push(dashes + boundary + dashes + crlf);
  return new Blob(parts, {
    type: "multipart/form-data; boundary=" + boundary,
  });
}

function escapeMultipartName(value: string): string {
  return String(value)
    .replace(/\r\n?|\n/g, "\r\n")
    .replace(/"/g, "%22")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A");
}

function serializeFormDataBodyInInit(init: any): any {
  if (!init || typeof init !== "object") return init;
  const body = (init as any).body;
  if (!(body instanceof FormData)) return init;
  const blob = formDataToMultipartBlob(body);
  const serializedInit = { ...init };
  serializedInit.body = blob;
  return serializedInit;
}

function isRetriableInternalError(error: unknown): boolean {
  return String((error as any)?.message ?? error).startsWith("internal error");
}

function requestUrlString(resolved: unknown, inputRequest: PageRequest | null): string {
  if (typeof resolved === "string") return resolved;
  if (resolved instanceof URL) return resolved.toString();
  return inputRequest ? inputRequest.url : "";
}

const CARRIED_STATUS_HEADER = "x-kitesurf-status";
const STATUS_CARRIER = 599;

function restoreCarriedStatus(response: Response): Response {
  const carried = responseHeaderGet(response, CARRIED_STATUS_HEADER);
  if (carried === null) return response;
  const authentic = responseStatus(response) === STATUS_CARRIER;
  const actualStatus = authentic ? Number(carried) : NaN;
  const visibleHeaders = newHeaders();
  for (const [name, value] of hdrEntries(responseHeaders(response))) {
    if (name.toLowerCase() !== CARRIED_STATUS_HEADER) {
      hdrAppend(visibleHeaders, name, value);
    }
  }
  try {
    Object.defineProperty(response, "headers", {
      value: visibleHeaders,
      configurable: true,
      enumerable: true,
    });
    if (Number.isFinite(actualStatus) && actualStatus > 0) {
      Object.defineProperty(response, "status", {
        value: actualStatus,
        configurable: true,
        enumerable: true,
      });
      Object.defineProperty(response, "ok", {
        value: actualStatus >= 200 && actualStatus <= 299,
        configurable: true,
        enumerable: true,
      });
    }
  } catch {}
  return response;
}

const MAX_REDIRECTS = 20;

const MAX_REPLAYABLE_BODY_BYTES = 1024 * 1024;

async function snapshotRequestBody(
  body: ReadableStream<Uint8Array>,
  cap: number,
  signal?: AbortSignal,
): Promise<{ replayable: Uint8Array | null; body: Uint8Array | ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    signal?.throwIfAborted?.();
    let readResult: { done?: boolean; value?: Uint8Array };
    try {
      readResult = await reader.read();
    } catch (e) {
      try {
        console.error("[kitesurf] request body stream errored:", e);
      } catch {}
      throw new TypeError("Failed to fetch");
    }
    if (readResult.done) {
      const bodyBytes = concatChunks(chunks, total);
      return { replayable: bodyBytes, body: bodyBytes };
    }
    const chunk = readResult.value;
    if (chunk === undefined) continue;
    if (!(chunk instanceof Uint8Array)) {
      try {
        reader.cancel();
      } catch {}
      throw new TypeError("Failed to fetch");
    }
    chunks.push(chunk);
    total += chunk.byteLength;
    if (total > cap) {
      const consumedChunks = chunks.slice();
      const replayStream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const consumedChunk of consumedChunks) controller.enqueue(consumedChunk);
        },
        async pull(controller) {
          try {
            const readResult = await reader.read();
            if (readResult.done) controller.close();
            else if (readResult.value) controller.enqueue(readResult.value);
          } catch (e) {
            controller.error(e);
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
      return { replayable: null, body: replayStream };
    }
  }
}

// Workerd omits these Request fields; page-provided values stay untrusted until narrowed.
interface PageRequestFields {
  credentials?: unknown;
  mode?: unknown;
  referrer?: unknown;
  referrerPolicy?: unknown;
}
type KsRequestInit = RequestInit & PageRequestFields & { duplex?: "half" };
type PageRequest = Request & PageRequestFields;

function isStreamBody(body: unknown): boolean {
  return typeof ReadableStream === "function" && body instanceof ReadableStream;
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const combinedBytes = new Uint8Array(total);
  let outputOffset = 0;
  for (const chunk of chunks) {
    combinedBytes.set(chunk, outputOffset);
    outputOffset += chunk.byteLength;
  }
  return combinedBytes;
}

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

interface RedirectContext {
  pageOrigin: string;
  headers: Headers;
  init: KsRequestInit;
  redirectMode: string;
  mode: string;
  inputRequest: PageRequest | null;
  checkRedirect: ((url: string) => string | null) | undefined;
}

function redirectDowngradesToGet(status: number, method: string): boolean {
  if (status === 303) return method !== "GET" && method !== "HEAD";
  return (status === 301 || status === 302) && method === "POST";
}

function opaqueRedirect(response: Response): Response {
  const opaqueResponse = newResponse(null, { status: responseStatus(response), statusText: "" });
  try {
    Object.defineProperty(opaqueResponse, "type", {
      value: "opaqueredirect",
      configurable: true,
      enumerable: true,
    });
  } catch {}
  return opaqueResponse;
}

async function throwIfBlocked(response: Response): Promise<void> {
  const blockedReason = responseHeaderGet(response, "x-kitesurf-blocked");
  if (responseStatus(response) === 403 && blockedReason) {
    // A CORS block rejects before any body read, and its diagnostic names the blocked
    // target: never hand it to a page-visible console callback.
    if (blockedReason === "cors") {
      cancelResponseBody(response);
      throw new TypeError("Failed to fetch");
    }
    throw new TypeError(await responseText(response));
  }
}

async function followRedirects(
  realFetch: typeof globalThis.fetch,
  first: Response,
  firstUrl: string,
  { pageOrigin, headers, init, redirectMode, mode, inputRequest, checkRedirect }: RedirectContext,
): Promise<{ response: Response; url: string; hops: number; tainting: "basic" | "cors" }> {
  // The shim owns redirects so each hop receives updated origin and referrer carriers.
  let response = first;
  let currentUrl = firstUrl;
  let hops = 0;
  let tainting: "basic" | "cors" = "basic";
  try {
    if (currentUrl && pageOrigin && new URL(currentUrl).origin !== pageOrigin) {
      tainting = "cors";
    }
  } catch {}
  let opaqueOrigin = !pageOrigin;
  let method = String(init.method ?? inputRequest?.method ?? "GET").toUpperCase();
  const signal = init.signal ?? undefined;
  let keepBody = true;

  for (;;) {
    const isRedirect = REDIRECT_STATUSES.indexOf(responseStatus(response)) !== -1;
    if (isRedirect && redirectMode === "manual") {
      return { response: opaqueRedirect(response), url: currentUrl, hops, tainting };
    }
    const rawLocation = isRedirect ? responseHeaderGet(response, "location") : null;
    if (rawLocation === null) return { response, url: currentUrl, hops, tainting };
    if (rawLocation === "") throw new TypeError("Failed to fetch");
    const location = rawLocation;
    if (redirectMode === "error") throw new TypeError("Failed to fetch");
    if (hops >= MAX_REDIRECTS) throw new TypeError("Failed to fetch");
    signal?.throwIfAborted?.();

    if (location.includes("\uFFFD")) {
      // A policy callback cannot vet an unparseable target, and the handoff below follows it
      // natively; refuse instead of fetching an unchecked hop.
      if (checkRedirect) throw new TypeError("Failed to fetch");
      if ((method !== "GET" && method !== "HEAD") || init.body != null) {
        throw new TypeError("Failed to fetch");
      }
      const handoff: KsRequestInit = copyOwnEnumerable<KsRequestInit>(init);
      defineOwn(handoff, "redirect", {
        value: "follow",
        writable: true,
        enumerable: true,
        configurable: true,
      });
      cancelResponseBody(response);
      const followed = await realFetch(currentUrl, handoff);
      await throwIfBlocked(followed);
      return { response: followed, url: currentUrl, hops, tainting };
    }
    let redirectTarget: URL;
    try {
      redirectTarget = new URL(location, currentUrl);
    } catch {
      throw new TypeError("Failed to fetch");
    }
    if (redirectTarget.protocol !== "http:" && redirectTarget.protocol !== "https:") {
      throw new TypeError("Failed to fetch");
    }
    if (mode !== "no-cors" && (redirectTarget.username !== "" || redirectTarget.password !== "")) {
      throw new TypeError("Failed to fetch");
    }
    if (checkRedirect) {
      // Before the hop is requested, so a refused target is never contacted.
      const next = checkRedirect(redirectTarget.toString());
      if (next === null) throw new TypeError("Failed to fetch");
      if (next !== redirectTarget.toString()) redirectTarget = new URL(next);
    }
    let currentHopOrigin = "";
    try {
      currentHopOrigin = new URL(currentUrl).origin;
    } catch {}
    if (tainting === "cors" && redirectTarget.origin !== currentHopOrigin) opaqueOrigin = true;
    if (redirectTarget.origin !== currentHopOrigin) hdrDelete(headers, "authorization");

    if (redirectDowngradesToGet(responseStatus(response), method)) {
      method = "GET";
      delete init.body;
      keepBody = false;
      for (const name of [
        "content-encoding",
        "content-language",
        "content-length",
        "content-location",
        "content-type",
      ]) {
        hdrDelete(headers, name);
      }
    }
    if (keepBody && isStreamBody(init.body)) {
      throw new TypeError("Failed to fetch");
    }
    const hopOrigin = opaqueOrigin ? "" : pageOrigin;
    hdrSet(headers, "x-kitesurf-page-origin", opaqueOrigin ? "null" : hopOrigin);
    hdrDelete(headers, "Origin");
    if (hopOrigin) {
      const isCrossOrigin = redirectTarget.origin !== hopOrigin;
      if (isCrossOrigin || (method !== "GET" && method !== "HEAD")) {
        hdrSet(headers, "Origin", hopOrigin);
      }
    }
    currentUrl = redirectTarget.toString();
    if (opaqueOrigin || (pageOrigin !== "" && redirectTarget.origin !== pageOrigin)) {
      tainting = "cors";
    }
    hops += 1;
    init.method = method;
    init.headers = headers;
    response = await realFetch(currentUrl, init);
    await throwIfBlocked(response);
  }
}

export function installFetchShim(): void {
  installHeadersForbiddenFilter();
  // Page script may replace the Request global; fetch must still recognise a request built with
  // the constructor installed here, as a browser's fetch never consults the global.
  const EngineRequest = installRequestShim();
  installResponseShim();
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== "function") return;
  const realFetch = routeViaSession(nativeFetch);
  const kitesurfFetchImpl = async function fetch(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    let resolved: typeof input = input;
    if (typeof input === "string") {
      resolved = state.pageUrl ? new URL(input, state.pageUrl).toString() : input;
    } else if (input instanceof URL) {
      resolved = input.toString();
    }
    const inputRequest =
      typeof EngineRequest === "function" && input instanceof EngineRequest
        ? (input as PageRequest)
        : null;
    const origin = state.documentOrigin;
    const initMaybeCoerced: KsRequestInit | undefined = serializeFormDataBodyInInit(
      validateAndStripCache(init, true),
    );
    // Own-enumerable copy on a null prototype: the untrusted init's getters still run, but no
    // later write of the stamped headers can reach a page-defined inherited setter.
    const mergedInit: KsRequestInit = copyOwnEnumerable<KsRequestInit>(initMaybeCoerced);
    const requestHeaders = newHeaders(
      mergedInit.headers ?? (inputRequest ? inputRequest.headers : {}),
    );
    hdrSet(requestHeaders, "x-kitesurf-page-origin", origin);
    if (state.connectionId) {
      hdrSet(requestHeaders, "x-kitesurf-connection-id", state.connectionId);
    } else {
      hdrDelete(requestHeaders, "x-kitesurf-connection-id");
    }
    if (state.mainFrameId) {
      hdrSet(requestHeaders, "x-kitesurf-frame-id", state.mainFrameId);
    } else {
      hdrDelete(requestHeaders, "x-kitesurf-frame-id");
    }
    if (state.cookieKey) {
      hdrSet(requestHeaders, "x-kitesurf-cookie-key", state.cookieKey);
    } else {
      hdrDelete(requestHeaders, "x-kitesurf-cookie-key");
    }
    // Only metadata in the private WeakMap may set engine-owned request attribution.
    const trustedMeta = takeTrustedRequestMeta(init);
    hdrSet(requestHeaders, "x-kitesurf-initiator", trustedMeta?.initiator || "script");
    hdrSet(requestHeaders, "x-kitesurf-resource-type", trustedMeta?.resourceType || "Fetch");
    if (!hdrHas(requestHeaders, "x-kitesurf-credentials")) {
      const requestCredentials = inputRequest ? inputRequest.credentials : undefined;
      const credentialsMode = String(
        initMaybeCoerced?.credentials ?? requestCredentials ?? "same-origin",
      );
      hdrSet(
        requestHeaders,
        "x-kitesurf-credentials",
        credentialsMode === "omit" || credentialsMode === "include"
          ? credentialsMode
          : "same-origin",
      );
    }
    const requestMode = String(initMaybeCoerced?.mode ?? inputRequest?.mode ?? "cors");
    hdrSet(requestHeaders, "x-kitesurf-mode", requestMode === "no-cors" ? "no-cors" : "cors");
    // Only applyCacheMode (session-outbound.ts) may mark the headers a cache mode adds.
    hdrDelete(requestHeaders, "x-kitesurf-cache-mode");
    // SAFETY: Strip page-supplied referrer carriers before deriving the trusted page referrer.
    hdrDelete(requestHeaders, "x-kitesurf-referrer");
    {
      const referrerInput =
        initMaybeCoerced?.referrer ?? (inputRequest ? inputRequest.referrer : undefined);
      if (referrerInput !== undefined && referrerInput !== null) {
        const referrerString = String(referrerInput);
        const requestReferrerPolicy = String(
          initMaybeCoerced?.referrerPolicy ??
            (inputRequest ? inputRequest.referrerPolicy : "") ??
            "",
        ).toLowerCase();
        if (referrerString === "" || requestReferrerPolicy === "no-referrer") {
          hdrSet(requestHeaders, "x-kitesurf-referrer", "no-referrer");
        } else if (referrerString !== "about:client") {
          let referrerUrl: URL | null = null;
          try {
            referrerUrl = new URL(referrerString, state.pageUrl || undefined);
          } catch {
            referrerUrl = null;
          }
          if (referrerUrl && origin && referrerUrl.origin === origin) {
            referrerUrl.hash = "";
            referrerUrl.username = "";
            referrerUrl.password = "";
            let targetCrossOrigin = false;
            try {
              const requestUrl = requestUrlString(resolved, inputRequest);
              targetCrossOrigin =
                !!requestUrl && new URL(requestUrl, state.pageUrl || undefined).origin !== origin;
            } catch {}
            const originOnly =
              requestReferrerPolicy === "origin" ||
              requestReferrerPolicy === "strict-origin" ||
              ((requestReferrerPolicy === "" ||
                requestReferrerPolicy === "origin-when-cross-origin" ||
                requestReferrerPolicy === "strict-origin-when-cross-origin") &&
                targetCrossOrigin);
            hdrSet(
              requestHeaders,
              "x-kitesurf-referrer",
              originOnly ? referrerUrl.origin + "/" : referrerUrl.href,
            );
          }
        }
      }
    }
    if (origin && !hdrHas(requestHeaders, "Origin")) {
      let requestOrigin = "";
      try {
        const resolvedRequestUrl = requestUrlString(resolved, inputRequest);
        if (resolvedRequestUrl) {
          requestOrigin = new URL(resolvedRequestUrl, state.pageUrl || undefined).origin;
        }
      } catch {}
      const isCrossOrigin = requestOrigin !== "" && requestOrigin !== origin;
      const method = String(mergedInit.method ?? inputRequest?.method ?? "GET").toUpperCase();
      const isSafeMethod = method === "GET" || method === "HEAD";
      if (isCrossOrigin || !isSafeMethod) {
        hdrSet(requestHeaders, "Origin", origin);
      }
    }
    defineOwn(mergedInit, "headers", {
      value: requestHeaders,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    if (
      String(initMaybeCoerced?.mode ?? inputRequest?.mode ?? "cors") === "no-cors" &&
      !["GET", "HEAD", "POST"].includes(
        String(mergedInit.method ?? inputRequest?.method ?? "GET").toUpperCase(),
      )
    ) {
      throw new TypeError(
        "Failed to execute 'fetch': mode 'no-cors' only permits GET, HEAD and POST",
      );
    }
    const redirectMode = String(mergedInit.redirect ?? inputRequest?.redirect ?? "follow");
    if (redirectMode !== "follow" && redirectMode !== "manual" && redirectMode !== "error") {
      throw new TypeError(
        `Failed to execute 'fetch': The provided value '${redirectMode}' is not a valid enum value of type RequestRedirect.`,
      );
    }
    mergedInit.redirect = "manual";
    if (inputRequest && inputRequest.body && mergedInit.body == null) {
      const snap = await snapshotRequestBody(
        inputRequest.body as ReadableStream<Uint8Array>,
        MAX_REPLAYABLE_BODY_BYTES,
        mergedInit.signal ?? inputRequest.signal ?? undefined,
      );
      const replayable = snap.replayable !== null;
      mergedInit.body = snap.body;
      if (!replayable) mergedInit.duplex = "half";
      mergedInit.method = mergedInit.method ?? inputRequest.method;
      mergedInit.signal = mergedInit.signal ?? inputRequest.signal;
      resolved = inputRequest.url;
    } else if (isStreamBody(mergedInit.body)) {
      const snap = await snapshotRequestBody(
        mergedInit.body as ReadableStream<Uint8Array>,
        MAX_REPLAYABLE_BODY_BYTES,
        mergedInit.signal ?? undefined,
      );
      mergedInit.body = snap.body;
      if (snap.replayable === null) mergedInit.duplex = "half";
    }
    let response: Response;
    try {
      response = await realFetch(resolved, mergedInit);
    } catch (error) {
      const retryMethod = String(
        mergedInit.method ??
          (typeof EngineRequest === "function" && resolved instanceof EngineRequest
            ? (resolved as any).method
            : "GET"),
      ).toUpperCase();
      const methodOk =
        retryMethod === "GET" ||
        retryMethod === "HEAD" ||
        retryMethod === "OPTIONS" ||
        retryMethod === "POST";
      const bodiless =
        mergedInit.body == null &&
        !(
          typeof EngineRequest === "function" &&
          resolved instanceof EngineRequest &&
          (resolved as any).body != null
        );
      const aborted = mergedInit.signal?.aborted === true;
      if (!isRetriableInternalError(error) || !methodOk || !bodiless || aborted) throw error;
      response = await realFetch(resolved, mergedInit);
    }
    const blockedReason = responseHeaderGet(response, "x-kitesurf-blocked");
    if (responseStatus(response) === 403 && blockedReason) {
      // See followRedirects: CORS rejects before the body is read, and no page-visible
      // console callback receives the diagnostic.
      if (blockedReason === "cors") {
        cancelResponseBody(response);
        throw new TypeError("Failed to fetch");
      }
      throw new TypeError(await responseText(response));
    }
    const hopStart = requestUrlString(resolved, inputRequest);
    const followed = await followRedirects(realFetch, response, hopStart, {
      pageOrigin: origin,
      headers: requestHeaders,
      init: mergedInit,
      redirectMode,
      mode: String(mergedInit.mode ?? inputRequest?.mode ?? "cors"),
      inputRequest,
      checkRedirect: trustedMeta?.checkRedirect,
    });
    response = followed.response;
    response = restoreCarriedStatus(response);
    if (followed.hops > 0) {
      try {
        Object.defineProperty(response, "url", {
          value: followed.url,
          configurable: true,
          enumerable: true,
        });
        Object.defineProperty(response, "redirected", {
          value: true,
          configurable: true,
          enumerable: true,
        });
      } catch {}
    }
    try {
      if ((response.type as string) === "opaqueredirect") return response;
      const finalRequestUrl = followed.url || requestUrlString(resolved, inputRequest);
      let computedType: "basic" | "cors" | "opaque" = "basic";
      if (followed.tainting === "cors") {
        const requestMode = String(mergedInit.mode ?? inputRequest?.mode ?? "cors");
        computedType = requestMode === "no-cors" ? "opaque" : "cors";
      } else if (finalRequestUrl && state.pageUrl) {
        const requestOrigin = new URL(finalRequestUrl, state.pageUrl).origin;
        const pageOrigin = state.documentOrigin;
        if (requestOrigin !== pageOrigin) computedType = "cors";
      }
      if (computedType === "opaque") {
        const OPAQUE_RESPONSE_CONSTRUCTION_STATUS = 400;
        const opaque = newResponse(null, {
          status: OPAQUE_RESPONSE_CONSTRUCTION_STATUS,
          headers: newHeaders(),
        });
        for (const [prop, value] of [
          ["type", "opaque"],
          ["status", 0],
          ["ok", false],
          ["statusText", ""],
          ["url", ""],
          ["redirected", false],
        ] as Array<[string, unknown]>) {
          try {
            Object.defineProperty(opaque, prop, {
              value,
              configurable: true,
              enumerable: true,
            });
          } catch {}
        }
        return opaque;
      }
      Object.defineProperty(response, "type", {
        value: computedType,
        configurable: true,
        enumerable: true,
        writable: false,
      });
    } catch {}
    return response;
  };

  (globalThis as { fetch: typeof fetch }).fetch = async function fetch(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    try {
      return await kitesurfFetchImpl(input, init);
    } catch (error) {
      if (error instanceof TypeError) throw error;
      const aborted =
        (init as KsRequestInit | undefined)?.signal?.aborted === true ||
        (typeof EngineRequest === "function" &&
          input instanceof EngineRequest &&
          input.signal?.aborted === true);
      if (aborted || (error as any)?.name === "AbortError") throw error;
      if (isDisallowedError(error)) throw error;
      try {
        console.error("[kitesurf] fetch network error:", error);
      } catch {}
      throw new TypeError("Failed to fetch");
    }
  };
}
