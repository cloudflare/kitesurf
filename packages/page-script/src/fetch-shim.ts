// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Wraps page fetch with gateway metadata, request validation, redirects, and response handling.

import { isDisallowedError } from "./defer-shim.ts";
import {
  hdrAppend,
  hdrDelete,
  hdrEntries,
  hdrGet,
  hdrHas,
  hdrSet,
  newHeaders,
  responseHeaderGet,
  responseHeaders,
} from "./native-http.ts";
import { ksGlobal, state } from "./state.ts";
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
    if (!isHttpUrl(url)) return "";
    return url.protocol + "//" + url.host;
  } catch {
    return "";
  }
}

function isHttpUrl(url: URL): boolean {
  return (url.protocol === "http:" || url.protocol === "https:") && url.host !== "";
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

function headersFilterMethods(headersPrototype: any): { append: Function; set: Function } | null {
  if (!headersPrototype || headersPrototype.__ksForbiddenFiltered) return null;
  const originalAppend = headersPrototype.append;
  const originalSet = headersPrototype.set;
  if (typeof originalAppend !== "function" || typeof originalSet !== "function") return null;
  return { append: originalAppend, set: originalSet };
}

function installHeadersForbiddenFilter(): void {
  const HeadersConstructor = ksGlobal.Headers;
  if (typeof HeadersConstructor !== "function") return;
  const headersPrototype = HeadersConstructor.prototype;
  const methods = headersFilterMethods(headersPrototype);
  if (!methods) return;
  const { append: originalAppend, set: originalSet } = methods;
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

function validateCacheMode(cache: string, init: any, isFetchCall: boolean): void {
  if (!VALID_CACHE_MODES.has(cache)) {
    throw new TypeError(
      `Failed to construct 'Request': The provided value '${cache}' is not a valid enum value of type RequestCache.`,
    );
  }
  if (cache !== "only-if-cached") return;
  if ((init as any).mode !== "same-origin") {
    throw new TypeError(
      "Failed to construct 'Request': 'only-if-cached' can be set only if 'mode' is 'same-origin'.",
    );
  }
  if (isFetchCall) {
    throw new TypeError("Failed to fetch: no cached response for 'only-if-cached' request.");
  }
}

function validateAndStripCache(init: any, isFetchCall: boolean): any {
  if (!init || typeof init !== "object" || (init as any).cache === undefined) return init;
  const cache = String((init as any).cache);
  validateCacheMode(cache, init, isFetchCall);
  if (WORKERD_CACHE_MODES.has(cache)) return init;
  const strippedInit = { ...init };
  delete strippedInit.cache;
  return strippedInit;
}

function installRequestShim(): void {
  const RealRequest = ksGlobal.Request;
  if (typeof RealRequest !== "function") return;
  if ((RealRequest as any).__ksWrapped) return;

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

  function rejectForbiddenRequestMethod(init: any): void {
    if (!init || typeof init !== "object" || typeof (init as any).method !== "string") return;
    const upper = String((init as any).method).toUpperCase();
    if (FORBIDDEN_METHODS.has(upper)) {
      throw new TypeError(
        `Failed to construct 'Request': '${(init as any).method}' HTTP method is unsupported.`,
      );
    }
  }

  const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);

  function WrappedRequest(this: any, input: any, init?: any) {
    const resolvedInput = resolveRequestInput(input);
    rejectForbiddenRequestMethod(init);
    const referrerState = requestReferrerState(input, init);
    // Workerd omits Request.referrer and Request.referrerPolicy.
    // Keep their state beside the native Request object.
    const effectiveInit = withNormalizedHeaderInit(
      serializeFormDataBodyInInit(validateAndStripCache(init, false)),
    );
    const request = new.target
      ? Reflect.construct(RealRequest, [resolvedInput, effectiveInit], new.target)
      : new RealRequest(resolvedInput, effectiveInit);
    requestReferrers.set(request, referrerState);
    return request;
  }
  WrappedRequest.prototype = RealRequest.prototype;
  Object.defineProperty(WrappedRequest, "name", { value: "Request" });
  (WrappedRequest as any).__ksWrapped = true;
  ksGlobal.Request = WrappedRequest;
  patchFormDataRealmCrossing(RealRequest.prototype);
  patchBodyBlobMimeType(RealRequest.prototype);
  installRequestReferrerAttributes(RealRequest.prototype);
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

function inheritedRequestReferrerState(input: unknown): RequestReferrerState {
  const inherited = input && typeof input === "object" ? requestReferrers.get(input) : undefined;
  return inherited ? { ...inherited } : { referrer: "client", policy: "" };
}

function resetReferrerStateForInit(next: RequestReferrerState, init: object): void {
  const hasInitMember = REQUEST_INIT_MEMBERS.some((key) => Reflect.get(init, key) !== undefined);
  if (hasInitMember) {
    next.referrer = "client";
    next.policy = "";
  }
}

function parseRequestReferrer(value: string): URL {
  try {
    return new URL(value, state.pageUrl || undefined);
  } catch {
    throw new TypeError(`Failed to construct 'Request': Referrer '${value}' is not a valid URL.`);
  }
}

function requestPageOrigin(): string {
  try {
    return new URL(state.pageUrl).origin;
  } catch {
    return "";
  }
}

function normalizedRequestReferrer(value: string): string {
  const parsed = parseRequestReferrer(value);
  const pageOrigin = requestPageOrigin();
  // about:client, or a cross-origin URL, falls back to the client.
  return parsed.href === "about:client" || parsed.origin !== pageOrigin ? "client" : parsed.href;
}

function setRequestReferrer(next: RequestReferrerState, referrerInit: unknown): void {
  if (referrerInit === undefined) return;
  const value = String(referrerInit);
  next.referrer = value === "" ? "no-referrer" : normalizedRequestReferrer(value);
}

function setRequestReferrerPolicy(next: RequestReferrerState, policyInit: unknown): void {
  if (policyInit === undefined) return;
  const policy = String(policyInit);
  if (!REFERRER_POLICY_VALUES.has(policy)) {
    throw new TypeError(
      `Failed to construct 'Request': The provided value '${policy}' is not a valid enum value of type ReferrerPolicy.`,
    );
  }
  next.policy = policy;
}

function requestReferrerState(input: unknown, init: unknown): RequestReferrerState {
  const next = inheritedRequestReferrerState(input);
  if (!init || typeof init !== "object") return next;
  const requestInit = init;
  resetReferrerStateForInit(next, requestInit);
  setRequestReferrer(next, Reflect.get(requestInit, "referrer"));
  setRequestReferrerPolicy(next, Reflect.get(requestInit, "referrerPolicy"));
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

  const WrappedResponse = function WrappedResponse(this: any, body?: any, init?: any) {
    const effectiveBody = body instanceof FormData ? formDataToMultipartBlob(body) : body;
    const effectiveInit = withNormalizedHeaderInit(init);
    if (new.target) {
      return Reflect.construct(RealResponse, [effectiveBody, effectiveInit], new.target);
    }
    return new RealResponse(effectiveBody, effectiveInit);
  };
  WrappedResponse.prototype = RealResponse.prototype;
  copyResponseStaticProperties(RealResponse, WrappedResponse);
  Object.defineProperty(WrappedResponse, "name", { value: "Response" });
  (WrappedResponse as any).__ksWrapped = true;
  ksGlobal.Response = WrappedResponse;
  patchFormDataRealmCrossing(RealResponse.prototype);
  patchBodyBlobMimeType(RealResponse.prototype);
}

function isResponseIntrinsicProperty(propertyName: string): boolean {
  return propertyName === "length" || propertyName === "name" || propertyName === "prototype";
}

function copyResponseStaticProperty(
  source: Function,
  target: Function,
  propertyName: string,
): void {
  if (isResponseIntrinsicProperty(propertyName)) return;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, propertyName);
    if (descriptor) Object.defineProperty(target, propertyName, descriptor);
  } catch {}
}

function copyResponseStaticProperties(source: Function, target: Function): void {
  for (const propertyName of Object.getOwnPropertyNames(source)) {
    copyResponseStaticProperty(source, target, propertyName);
  }
}

function installBlobMimeTypePatch(prototype: object, blob: Function): void {
  if (
    !Reflect.set(prototype, "blob", blob, prototype) ||
    !Reflect.set(prototype, "__ksMimeTypeBlobPatched", true, prototype)
  ) {
    throw new TypeError("Cannot patch Body.blob()");
  }
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
  installBlobMimeTypePatch(prototype, blob);
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

function multipartBlobMetadata(value: File | Blob): { filename: string; contentType: string } {
  const filename = (value && (value as File).name) || "blob";
  const contentType = (value && (value as Blob).type) || "application/octet-stream";
  return { filename, contentType };
}

function appendTextMultipartPart(
  parts: BlobPart[],
  name: string,
  value: string,
  boundary: string,
  dashes: string,
  crlf: string,
): void {
  const header =
    dashes +
    boundary +
    crlf +
    'Content-Disposition: form-data; name="' +
    escapeMultipartName(name) +
    '"' +
    crlf +
    crlf;
  parts.push(header);
  parts.push(value);
  parts.push(crlf);
}

function appendFileMultipartPart(
  parts: BlobPart[],
  name: string,
  value: Blob,
  boundary: string,
  dashes: string,
  crlf: string,
): void {
  const { filename, contentType } = multipartBlobMetadata(value);
  const header =
    dashes +
    boundary +
    crlf +
    'Content-Disposition: form-data; name="' +
    escapeMultipartName(name) +
    '"; filename="' +
    escapeMultipartName(filename) +
    '"' +
    crlf +
    "Content-Type: " +
    contentType +
    crlf +
    crlf;
  parts.push(header);
  parts.push(value);
  parts.push(crlf);
}

function formDataToMultipartBlob(formData: FormData): Blob {
  const boundary = "----formdata-kitesurf-" + Math.random().toString(36).slice(2, 18);
  const parts: BlobPart[] = [];
  const dashes = "--";
  const crlf = "\r\n";
  for (const [name, value] of formData as any) {
    if (typeof value === "string") {
      appendTextMultipartPart(parts, name, value, boundary, dashes, crlf);
    } else {
      appendFileMultipartPart(parts, name, value, boundary, dashes, crlf);
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

function responseHeadersWithoutCarriedStatus(response: Response): Headers {
  const visibleHeaders = newHeaders();
  for (const [name, value] of hdrEntries(responseHeaders(response))) {
    if (name.toLowerCase() !== CARRIED_STATUS_HEADER) {
      hdrAppend(visibleHeaders, name, value);
    }
  }
  return visibleHeaders;
}

function restoreResponseStatus(response: Response, actualStatus: number): void {
  if (!Number.isFinite(actualStatus) || actualStatus <= 0) return;
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

function restoreCarriedStatus(response: Response): Response {
  const carried = responseHeaderGet(response, CARRIED_STATUS_HEADER);
  if (carried === null) return response;
  const actualStatus = response.status === STATUS_CARRIER ? Number(carried) : NaN;
  const visibleHeaders = responseHeadersWithoutCarriedStatus(response);
  try {
    Object.defineProperty(response, "headers", {
      value: visibleHeaders,
      configurable: true,
      enumerable: true,
    });
    restoreResponseStatus(response, actualStatus);
  } catch {}
  return response;
}

const MAX_REDIRECTS = 20;

const MAX_REPLAYABLE_BODY_BYTES = 1024 * 1024;

type RequestBodySnapshot = {
  replayable: Uint8Array | null;
  body: Uint8Array | ReadableStream<Uint8Array>;
};

function throwIfRequestBodyAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted?.();
}

async function readRequestBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ done?: boolean; value?: Uint8Array }> {
  try {
    return await reader.read();
  } catch (error) {
    try {
      console.error("[kitesurf] request body stream errored:", error);
    } catch {}
    throw new TypeError("Failed to fetch");
  }
}

function cancelInvalidRequestBody(reader: ReadableStreamDefaultReader<Uint8Array>): never {
  try {
    reader.cancel();
  } catch {}
  throw new TypeError("Failed to fetch");
}

function appendRequestBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunks: Uint8Array[],
  total: number,
  chunk: unknown,
): number {
  if (chunk === undefined) return total;
  if (!(chunk instanceof Uint8Array)) cancelInvalidRequestBody(reader);
  chunks.push(chunk);
  return total + chunk.byteLength;
}

function completeRequestBodySnapshot(chunks: Uint8Array[], total: number): RequestBodySnapshot {
  const bodyBytes = concatChunks(chunks, total);
  return { replayable: bodyBytes, body: bodyBytes };
}

function replayOversizeRequestBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  chunks: Uint8Array[],
): RequestBodySnapshot {
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
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { replayable: null, body: replayStream };
}

async function snapshotRequestBody(
  body: ReadableStream<Uint8Array>,
  cap: number,
  signal?: AbortSignal,
): Promise<RequestBodySnapshot> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    throwIfRequestBodyAborted(signal);
    const readResult = await readRequestBody(reader);
    if (readResult.done) return completeRequestBodySnapshot(chunks, total);
    total = appendRequestBodyChunk(reader, chunks, total, readResult.value);
    if (total > cap) return replayOversizeRequestBody(reader, chunks);
  }
}

function throwIfRedirectAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted?.();
}

async function throwIfBlockedResponse(response: Response): Promise<void> {
  const blockedReason = responseHeaderGet(response, "x-kitesurf-blocked");
  if (response.status !== 403 || !blockedReason) return;
  const detail = await response.text();
  try {
    console.error(detail);
  } catch {}
  if (blockedReason === "cors") throw new TypeError("Failed to fetch");
  throw new TypeError(detail);
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
}

interface RedirectState {
  response: Response;
  currentUrl: string;
  hops: number;
  tainting: "basic" | "cors";
  opaqueOrigin: boolean;
  method: string;
  keepBody: boolean;
}

type RedirectResult = {
  response: Response;
  url: string;
  hops: number;
  tainting: "basic" | "cors";
};

type RedirectDecision =
  | { kind: "done"; result: RedirectResult }
  | { kind: "follow"; location: string };

function redirectDowngradesToGet(status: number, method: string): boolean {
  if (status === 303) return method !== "GET" && method !== "HEAD";
  return (status === 301 || status === 302) && method === "POST";
}

function opaqueRedirect(response: Response): Response {
  const opaqueResponse = new Response(null, { status: response.status, statusText: "" });
  try {
    Object.defineProperty(opaqueResponse, "type", {
      value: "opaqueredirect",
      configurable: true,
      enumerable: true,
    });
  } catch {}
  return opaqueResponse;
}

function originOfUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function isCrossOriginUrl(url: string, pageOrigin: string): boolean {
  if (!url || !pageOrigin) return false;
  try {
    return new URL(url).origin !== pageOrigin;
  } catch {
    return false;
  }
}

function createRedirectState(
  first: Response,
  firstUrl: string,
  { pageOrigin, init, inputRequest }: RedirectContext,
): RedirectState {
  return {
    response: first,
    currentUrl: firstUrl,
    hops: 0,
    tainting: isCrossOriginUrl(firstUrl, pageOrigin) ? "cors" : "basic",
    opaqueOrigin: !pageOrigin,
    method: String(init.method ?? inputRequest?.method ?? "GET").toUpperCase(),
    keepBody: true,
  };
}

function isRedirectResponse(response: Response): boolean {
  return REDIRECT_STATUSES.indexOf(response.status) !== -1;
}

function redirectResult(state: RedirectState, response = state.response): RedirectResult {
  return {
    response,
    url: state.currentUrl,
    hops: state.hops,
    tainting: state.tainting,
  };
}

function manualRedirectResult(
  state: RedirectState,
  redirectMode: string,
  isRedirect: boolean,
): RedirectResult | null {
  if (!isRedirect || redirectMode !== "manual") return null;
  return redirectResult(state, opaqueRedirect(state.response));
}

function redirectLocation(state: RedirectState, isRedirect: boolean): string | null {
  return isRedirect ? responseHeaderGet(state.response, "location") : null;
}

function assertRedirectCanBeFollowed(location: string, redirectMode: string, hops: number): void {
  if (location === "") throw new TypeError("Failed to fetch");
  if (redirectMode === "error") throw new TypeError("Failed to fetch");
  if (hops >= MAX_REDIRECTS) throw new TypeError("Failed to fetch");
}

function inspectRedirect(state: RedirectState, redirectMode: string): RedirectDecision {
  const isRedirect = isRedirectResponse(state.response);
  const manualResult = manualRedirectResult(state, redirectMode, isRedirect);
  if (manualResult !== null) return { kind: "done", result: manualResult };
  const location = redirectLocation(state, isRedirect);
  if (location === null) return { kind: "done", result: redirectResult(state) };
  assertRedirectCanBeFollowed(location, redirectMode, state.hops);
  return { kind: "follow", location };
}

function isBodylessGet(method: string, body: BodyInit | null | undefined): boolean {
  return (method === "GET" || method === "HEAD") && body == null;
}

async function followReplacementRedirect(
  realFetch: typeof globalThis.fetch,
  state: RedirectState,
  location: string,
  context: RedirectContext,
): Promise<RedirectResult | null> {
  if (!location.includes("\uFFFD")) return null;
  if (!isBodylessGet(state.method, context.init.body)) {
    throw new TypeError("Failed to fetch");
  }
  const handoff: KsRequestInit = { ...context.init, redirect: "follow" };
  const response = await realFetch(state.currentUrl, handoff);
  return redirectResult(state, response);
}

function parseRedirectTarget(location: string, currentUrl: string): URL {
  try {
    return new URL(location, currentUrl);
  } catch {
    throw new TypeError("Failed to fetch");
  }
}

function redirectTargetHasHttpProtocol(target: URL): boolean {
  return target.protocol === "http:" || target.protocol === "https:";
}

function validateRedirectTarget(target: URL, mode: string): void {
  if (!redirectTargetHasHttpProtocol(target)) throw new TypeError("Failed to fetch");
  if (mode !== "no-cors" && (target.username !== "" || target.password !== "")) {
    throw new TypeError("Failed to fetch");
  }
}

function updateRedirectOriginState(
  state: RedirectState,
  target: URL,
  currentHopOrigin: string,
  headers: Headers,
): void {
  if (state.tainting === "cors" && target.origin !== currentHopOrigin) {
    state.opaqueOrigin = true;
  }
  if (target.origin !== currentHopOrigin) hdrDelete(headers, "authorization");
}

function stripRedirectBodyHeaders(headers: Headers): void {
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

function downgradeRedirectRequest(
  state: RedirectState,
  response: Response,
  init: KsRequestInit,
  headers: Headers,
): void {
  if (!redirectDowngradesToGet(response.status, state.method)) return;
  state.method = "GET";
  delete init.body;
  state.keepBody = false;
  stripRedirectBodyHeaders(headers);
}

function assertRedirectBodyReplayable(
  state: RedirectState,
  body: BodyInit | null | undefined,
): void {
  if (state.keepBody && isStreamBody(body)) throw new TypeError("Failed to fetch");
}

function setRedirectOriginHeader(
  headers: Headers,
  target: URL,
  hopOrigin: string,
  method: string,
): void {
  if (!hopOrigin) return;
  const isCrossOrigin = target.origin !== hopOrigin;
  if (isCrossOrigin || (method !== "GET" && method !== "HEAD")) {
    hdrSet(headers, "Origin", hopOrigin);
  }
}

function setRedirectRequestHeaders(
  state: RedirectState,
  target: URL,
  context: RedirectContext,
): void {
  const hopOrigin = state.opaqueOrigin ? "" : context.pageOrigin;
  hdrSet(context.headers, "x-kitesurf-page-origin", state.opaqueOrigin ? "null" : hopOrigin);
  hdrDelete(context.headers, "Origin");
  setRedirectOriginHeader(context.headers, target, hopOrigin, state.method);
}

function updateRedirectTainting(state: RedirectState, target: URL, pageOrigin: string): void {
  if (state.opaqueOrigin || (pageOrigin !== "" && target.origin !== pageOrigin)) {
    state.tainting = "cors";
  }
}

function prepareRedirectHop(state: RedirectState, target: URL, context: RedirectContext): void {
  const currentHopOrigin = originOfUrl(state.currentUrl);
  updateRedirectOriginState(state, target, currentHopOrigin, context.headers);
  downgradeRedirectRequest(state, state.response, context.init, context.headers);
  assertRedirectBodyReplayable(state, context.init.body);
  setRedirectRequestHeaders(state, target, context);
  state.currentUrl = target.toString();
  updateRedirectTainting(state, target, context.pageOrigin);
  state.hops += 1;
  context.init.method = state.method;
  context.init.headers = context.headers;
}

async function followRedirectLoop(
  realFetch: typeof globalThis.fetch,
  state: RedirectState,
  context: RedirectContext,
): Promise<RedirectResult> {
  const signal = context.init.signal ?? undefined;
  for (;;) {
    const decision = inspectRedirect(state, context.redirectMode);
    if (decision.kind === "done") return decision.result;
    throwIfRedirectAborted(signal);
    const handoff = await followReplacementRedirect(realFetch, state, decision.location, context);
    if (handoff !== null) return handoff;
    const target = parseRedirectTarget(decision.location, state.currentUrl);
    validateRedirectTarget(target, context.mode);
    prepareRedirectHop(state, target, context);
    state.response = await realFetch(state.currentUrl, context.init);
    await throwIfBlockedResponse(state.response);
  }
}

async function followRedirects(
  realFetch: typeof globalThis.fetch,
  first: Response,
  firstUrl: string,
  { pageOrigin, headers, init, redirectMode, mode, inputRequest }: RedirectContext,
): Promise<{ response: Response; url: string; hops: number; tainting: "basic" | "cors" }> {
  // The shim owns redirects so each hop receives updated origin and referrer carriers.
  const state = createRedirectState(first, firstUrl, {
    pageOrigin,
    headers,
    init,
    redirectMode,
    mode,
    inputRequest,
  });
  return followRedirectLoop(realFetch, state, {
    pageOrigin,
    headers,
    init,
    redirectMode,
    mode,
    inputRequest,
  });
}

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

function resolveFetchInput(input: FetchInput): FetchInput {
  if (typeof input === "string") {
    return state.pageUrl ? new URL(input, state.pageUrl).toString() : input;
  }
  if (input instanceof URL) return input.toString();
  return input;
}

function pageRequestFromInput(input: FetchInput): PageRequest | null {
  return typeof Request === "function" && input instanceof Request ? (input as PageRequest) : null;
}

function coerceFetchInit(init: FetchInit): KsRequestInit | undefined {
  return serializeFormDataBodyInInit(validateAndStripCache(init, true));
}

function sourceFetchHeaders(
  mergedInit: KsRequestInit,
  inputRequest: PageRequest | null,
): HeadersInit {
  return mergedInit.headers ?? (inputRequest ? inputRequest.headers : {});
}

function setPageMetadataHeaders(headers: Headers): void {
  if (state.connectionId) {
    hdrSet(headers, "x-kitesurf-connection-id", state.connectionId);
  } else {
    hdrDelete(headers, "x-kitesurf-connection-id");
  }
  if (state.mainFrameId) {
    hdrSet(headers, "x-kitesurf-frame-id", state.mainFrameId);
  } else {
    hdrDelete(headers, "x-kitesurf-frame-id");
  }
  if (state.cookieKey) {
    hdrSet(headers, "x-kitesurf-cookie-key", state.cookieKey);
  } else {
    hdrDelete(headers, "x-kitesurf-cookie-key");
  }
}

function setFetchCredentialsHeader(
  headers: Headers,
  initMaybeCoerced: KsRequestInit | undefined,
  inputRequest: PageRequest | null,
): void {
  if (hdrHas(headers, "x-kitesurf-credentials")) return;
  const credentialsMode = fetchCredentialsMode(initMaybeCoerced, inputRequest);
  hdrSet(headers, "x-kitesurf-credentials", fetchCredentialsHeaderValue(credentialsMode));
}

function pageRequestCredentials(inputRequest: PageRequest | null): unknown {
  return inputRequest ? inputRequest.credentials : undefined;
}

function fetchCredentialsMode(
  initMaybeCoerced: KsRequestInit | undefined,
  inputRequest: PageRequest | null,
): string {
  const requestCredentials = pageRequestCredentials(inputRequest);
  return String(initMaybeCoerced?.credentials ?? requestCredentials ?? "same-origin");
}

function fetchCredentialsHeaderValue(credentialsMode: string): string {
  return credentialsMode === "omit" || credentialsMode === "include"
    ? credentialsMode
    : "same-origin";
}

function pageRequestMode(inputRequest: PageRequest | null): unknown {
  return inputRequest?.mode ?? "cors";
}

function fetchRequestMode(
  initMaybeCoerced: KsRequestInit | undefined,
  inputRequest: PageRequest | null,
): string {
  return String(initMaybeCoerced?.mode ?? pageRequestMode(inputRequest));
}

function fetchModeHeaderValue(requestMode: string): string {
  return requestMode === "no-cors" ? "no-cors" : "cors";
}

function setFetchModeHeader(
  headers: Headers,
  initMaybeCoerced: KsRequestInit | undefined,
  inputRequest: PageRequest | null,
): void {
  const requestMode = fetchRequestMode(initMaybeCoerced, inputRequest);
  hdrSet(headers, "x-kitesurf-mode", fetchModeHeaderValue(requestMode));
}

function createFetchRequestHeaders(
  init: FetchInit,
  initMaybeCoerced: KsRequestInit | undefined,
  mergedInit: KsRequestInit,
  inputRequest: PageRequest | null,
  origin: string,
): Headers {
  const headers = newHeaders(sourceFetchHeaders(mergedInit, inputRequest));
  hdrSet(headers, "x-kitesurf-page-origin", origin);
  setPageMetadataHeaders(headers);
  // Only metadata in the private WeakMap may set engine-owned request attribution.
  const trustedMeta = takeTrustedRequestMeta(init);
  hdrSet(headers, "x-kitesurf-initiator", trustedMeta?.initiator || "script");
  hdrSet(headers, "x-kitesurf-resource-type", trustedMeta?.resourceType || "Fetch");
  setFetchCredentialsHeader(headers, initMaybeCoerced, inputRequest);
  setFetchModeHeader(headers, initMaybeCoerced, inputRequest);
  return headers;
}

function parseFetchReferrer(referrerString: string): URL | null {
  try {
    return new URL(referrerString, state.pageUrl || undefined);
  } catch {
    return null;
  }
}

function sameOriginFetchReferrer(referrerString: string, origin: string): URL | null {
  const referrerUrl = parseFetchReferrer(referrerString);
  if (!referrerUrl || !origin || referrerUrl.origin !== origin) return null;
  referrerUrl.hash = "";
  referrerUrl.username = "";
  referrerUrl.password = "";
  return referrerUrl;
}

function isOriginOnlyReferrerPolicy(policy: string): boolean {
  return policy === "origin" || policy === "strict-origin";
}

function isCrossOriginOriginReferrerPolicy(policy: string): boolean {
  return (
    policy === "" ||
    policy === "origin-when-cross-origin" ||
    policy === "strict-origin-when-cross-origin"
  );
}

function isCrossOriginFetchTarget(
  resolved: FetchInput,
  inputRequest: PageRequest | null,
  origin: string,
): boolean {
  try {
    const requestUrl = requestUrlString(resolved, inputRequest);
    return !!requestUrl && new URL(requestUrl, state.pageUrl || undefined).origin !== origin;
  } catch {
    return false;
  }
}

function isNoReferrerValue(referrerString: string, policy: string): boolean {
  return referrerString === "" || policy === "no-referrer";
}

function shouldSendOriginOnlyReferrer(policy: string, targetCrossOrigin: boolean): boolean {
  return (
    isOriginOnlyReferrerPolicy(policy) ||
    (isCrossOriginOriginReferrerPolicy(policy) && targetCrossOrigin)
  );
}

function fetchReferrerHeaderValue(
  referrerString: string,
  policy: string,
  resolved: FetchInput,
  inputRequest: PageRequest | null,
  origin: string,
): string | null {
  if (isNoReferrerValue(referrerString, policy)) return "no-referrer";
  if (referrerString === "about:client") return null;
  const referrerUrl = sameOriginFetchReferrer(referrerString, origin);
  if (!referrerUrl) return null;
  const targetCrossOrigin = isCrossOriginFetchTarget(resolved, inputRequest, origin);
  return shouldSendOriginOnlyReferrer(policy, targetCrossOrigin)
    ? referrerUrl.origin + "/"
    : referrerUrl.href;
}

function setFetchReferrerHeader(
  headers: Headers,
  initMaybeCoerced: KsRequestInit | undefined,
  inputRequest: PageRequest | null,
  resolved: FetchInput,
  origin: string,
): void {
  // SAFETY: Strip page-supplied referrer carriers before deriving the trusted page referrer.
  hdrDelete(headers, "x-kitesurf-referrer");
  const referrerInput = fetchReferrerInput(initMaybeCoerced, inputRequest);
  if (referrerInput === undefined || referrerInput === null) return;
  const referrerString = String(referrerInput);
  const policy = fetchReferrerPolicy(initMaybeCoerced, inputRequest);
  const value = fetchReferrerHeaderValue(referrerString, policy, resolved, inputRequest, origin);
  if (value !== null) hdrSet(headers, "x-kitesurf-referrer", value);
}

function fetchReferrerInput(
  initMaybeCoerced: KsRequestInit | undefined,
  inputRequest: PageRequest | null,
): unknown {
  return initMaybeCoerced?.referrer ?? (inputRequest ? inputRequest.referrer : undefined);
}

function pageRequestReferrerPolicy(inputRequest: PageRequest | null): unknown {
  return inputRequest?.referrerPolicy ?? "";
}

function fetchReferrerPolicy(
  initMaybeCoerced: KsRequestInit | undefined,
  inputRequest: PageRequest | null,
): string {
  return String(
    initMaybeCoerced?.referrerPolicy ?? pageRequestReferrerPolicy(inputRequest) ?? "",
  ).toLowerCase();
}

function requestOriginForInput(resolved: FetchInput, inputRequest: PageRequest | null): string {
  try {
    const requestUrl = requestUrlString(resolved, inputRequest);
    if (!requestUrl) return "";
    return new URL(requestUrl, state.pageUrl || undefined).origin;
  } catch {
    return "";
  }
}

function isSafeFetchMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function shouldSetFetchOriginHeader(
  origin: string,
  requestOrigin: string,
  method: string,
): boolean {
  const isCrossOrigin = requestOrigin !== "" && requestOrigin !== origin;
  return isCrossOrigin || !isSafeFetchMethod(method);
}

function setFetchOriginHeader(
  headers: Headers,
  origin: string,
  resolved: FetchInput,
  inputRequest: PageRequest | null,
  mergedInit: KsRequestInit,
): void {
  if (!origin) return;
  if (hdrHas(headers, "Origin")) return;
  const requestOrigin = requestOriginForInput(resolved, inputRequest);
  const method = requestMethodForInput(mergedInit, inputRequest);
  if (shouldSetFetchOriginHeader(origin, requestOrigin, method)) {
    hdrSet(headers, "Origin", origin);
  }
}

function requestMethodForInput(
  mergedInit: KsRequestInit,
  inputRequest: PageRequest | null,
): string {
  return String(mergedInit.method ?? inputRequest?.method ?? "GET").toUpperCase();
}

function isNoCorsFetchMode(
  initMaybeCoerced: KsRequestInit | undefined,
  inputRequest: PageRequest | null,
): boolean {
  return fetchRequestMode(initMaybeCoerced, inputRequest) === "no-cors";
}

function isNoCorsFetchMethod(mergedInit: KsRequestInit, inputRequest: PageRequest | null): boolean {
  return ["GET", "HEAD", "POST"].includes(requestMethodForInput(mergedInit, inputRequest));
}

function validateNoCorsRequest(
  initMaybeCoerced: KsRequestInit | undefined,
  inputRequest: PageRequest | null,
  mergedInit: KsRequestInit,
): void {
  if (
    isNoCorsFetchMode(initMaybeCoerced, inputRequest) &&
    !isNoCorsFetchMethod(mergedInit, inputRequest)
  ) {
    throw new TypeError(
      "Failed to execute 'fetch': mode 'no-cors' only permits GET, HEAD and POST",
    );
  }
}

function validatedRedirectMode(
  mergedInit: KsRequestInit,
  inputRequest: PageRequest | null,
): string {
  const redirectMode = fetchRedirectMode(mergedInit, inputRequest);
  if (!isValidFetchRedirectMode(redirectMode)) {
    throw new TypeError(
      `Failed to execute 'fetch': The provided value '${redirectMode}' is not a valid enum value of type RequestRedirect.`,
    );
  }
  return redirectMode;
}

function isValidFetchRedirectMode(redirectMode: string): boolean {
  return redirectMode === "follow" || redirectMode === "manual" || redirectMode === "error";
}

function fetchRedirectMode(mergedInit: KsRequestInit, inputRequest: PageRequest | null): string {
  return String(mergedInit.redirect ?? inputRequest?.redirect ?? "follow");
}

function applyRequestBodySnapshot(init: KsRequestInit, snapshot: RequestBodySnapshot): void {
  init.body = snapshot.body;
  if (snapshot.replayable === null) init.duplex = "half";
}

async function snapshotInputRequestBody(
  inputRequest: PageRequest,
  init: KsRequestInit,
): Promise<FetchInput> {
  const snapshot = await snapshotRequestBody(
    inputRequest.body as ReadableStream<Uint8Array>,
    MAX_REPLAYABLE_BODY_BYTES,
    init.signal ?? inputRequest.signal ?? undefined,
  );
  applyRequestBodySnapshot(init, snapshot);
  init.method = init.method ?? inputRequest.method;
  init.signal = init.signal ?? inputRequest.signal;
  return inputRequest.url;
}

async function snapshotFetchRequestBody(
  resolved: FetchInput,
  inputRequest: PageRequest | null,
  init: KsRequestInit,
): Promise<FetchInput> {
  if (inputRequestBodyNeedsSnapshot(inputRequest, init)) {
    return snapshotInputRequestBody(inputRequest, init);
  }
  if (!isStreamBody(init.body)) return resolved;
  const snapshot = await snapshotRequestBody(
    init.body as ReadableStream<Uint8Array>,
    MAX_REPLAYABLE_BODY_BYTES,
    init.signal ?? undefined,
  );
  applyRequestBodySnapshot(init, snapshot);
  return resolved;
}

function inputRequestBodyNeedsSnapshot(
  inputRequest: PageRequest | null,
  init: KsRequestInit,
): inputRequest is PageRequest {
  return !!(inputRequest && inputRequest.body && init.body == null);
}

function retryMethodForInput(resolved: FetchInput, init: KsRequestInit): string {
  return String(
    init.method ??
      (typeof Request === "function" && resolved instanceof Request
        ? (resolved as any).method
        : "GET"),
  ).toUpperCase();
}

function isRetriableFetchMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS" || method === "POST";
}

function retryRequestIsBodiless(resolved: FetchInput, init: KsRequestInit): boolean {
  return (
    init.body == null &&
    !(
      typeof Request === "function" &&
      resolved instanceof Request &&
      (resolved as any).body != null
    )
  );
}

function shouldRetryFetch(error: unknown, resolved: FetchInput, init: KsRequestInit): boolean {
  const retryMethod = retryMethodForInput(resolved, init);
  const methodOk = isRetriableFetchMethod(retryMethod);
  const bodiless = retryRequestIsBodiless(resolved, init);
  const aborted = init.signal?.aborted === true;
  const retriable = isRetriableInternalError(error);
  return retriable && methodOk && bodiless && !aborted;
}

async function fetchWithInternalRetry(
  realFetch: typeof globalThis.fetch,
  resolved: FetchInput,
  init: KsRequestInit,
): Promise<Response> {
  try {
    return await realFetch(resolved, init);
  } catch (error) {
    if (!shouldRetryFetch(error, resolved, init)) throw error;
    return await realFetch(resolved, init);
  }
}

function validateFetchRequest(
  initMaybeCoerced: KsRequestInit | undefined,
  inputRequest: PageRequest | null,
  mergedInit: KsRequestInit,
): string {
  validateNoCorsRequest(initMaybeCoerced, inputRequest, mergedInit);
  const redirectMode = validatedRedirectMode(mergedInit, inputRequest);
  mergedInit.redirect = "manual";
  return redirectMode;
}

function responseTypeForUrl(finalRequestUrl: string): "basic" | "cors" {
  if (!finalRequestUrl || !state.pageUrl) return "basic";
  const requestOrigin = new URL(finalRequestUrl, state.pageUrl).origin;
  const pageOrigin = new URL(state.pageUrl).origin;
  return requestOrigin !== pageOrigin ? "cors" : "basic";
}

function fetchResponseType(
  followed: RedirectResult,
  resolved: FetchInput,
  inputRequest: PageRequest | null,
  init: KsRequestInit,
): "basic" | "cors" | "opaque" {
  if (followed.tainting === "cors") {
    const requestMode = fetchRequestMode(init, inputRequest);
    return requestMode === "no-cors" ? "opaque" : "cors";
  }
  const finalRequestUrl = followed.url || requestUrlString(resolved, inputRequest);
  return responseTypeForUrl(finalRequestUrl);
}

function createOpaqueFetchResponse(): Response {
  const OPAQUE_RESPONSE_CONSTRUCTION_STATUS = 400;
  const opaque = new Response(null, {
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

function applyFetchResponseType(
  response: Response,
  computedType: "basic" | "cors" | "opaque",
): Response {
  if (computedType === "opaque") return createOpaqueFetchResponse();
  Object.defineProperty(response, "type", {
    value: computedType,
    configurable: true,
    enumerable: true,
    writable: false,
  });
  return response;
}

function setRedirectedResponseMetadata(response: Response, followed: RedirectResult): void {
  if (followed.hops <= 0) return;
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

function applyFetchResponseTypeIfReadable(
  response: Response,
  followed: RedirectResult,
  resolved: FetchInput,
  inputRequest: PageRequest | null,
  init: KsRequestInit,
): Response {
  try {
    if ((response.type as string) === "opaqueredirect") return response;
    return applyFetchResponseType(
      response,
      fetchResponseType(followed, resolved, inputRequest, init),
    );
  } catch {}
  return response;
}

function finalizeFetchResponse(
  response: Response,
  followed: RedirectResult,
  resolved: FetchInput,
  inputRequest: PageRequest | null,
  init: KsRequestInit,
): Response {
  const restored = restoreCarriedStatus(response);
  setRedirectedResponseMetadata(restored, followed);
  return applyFetchResponseTypeIfReadable(restored, followed, resolved, inputRequest, init);
}

function isFetchInitAborted(init: FetchInit): boolean {
  return (init as KsRequestInit | undefined)?.signal?.aborted === true;
}

function isRequestInputAborted(input: FetchInput): boolean {
  if (typeof Request === "function" && input instanceof Request) {
    return input.signal?.aborted === true;
  }
  return false;
}

function isFetchSignalAborted(init: FetchInit, input: FetchInput): boolean {
  if (isFetchInitAborted(init)) return true;
  return isRequestInputAborted(input);
}

function isAbortError(error: unknown): boolean {
  return (error as any)?.name === "AbortError";
}

function isFetchAbortError(error: unknown, init: FetchInit, input: FetchInput): boolean {
  return isFetchSignalAborted(init, input) || isAbortError(error);
}

function shouldPassThroughFetchError(error: unknown, init: FetchInit, input: FetchInput): boolean {
  if (error instanceof TypeError) return true;
  if (isFetchAbortError(error, init, input)) return true;
  return isDisallowedError(error);
}

function logFetchNetworkError(error: unknown): void {
  try {
    console.error("[kitesurf] fetch network error:", error);
  } catch {}
}

export function installFetchShim(): void {
  installHeadersForbiddenFilter();
  installRequestShim();
  installResponseShim();
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== "function") return;
  const realFetch = routeViaSession(nativeFetch);
  const kitesurfFetchImpl = async function fetch(
    input: FetchInput,
    init?: FetchInit,
  ): Promise<Response> {
    let resolved = resolveFetchInput(input);
    const inputRequest = pageRequestFromInput(input);
    const origin = pageOriginFromUrl(state.pageUrl);
    const initMaybeCoerced = coerceFetchInit(init);
    const mergedInit: KsRequestInit = { ...(initMaybeCoerced || {}) };
    const requestHeaders = createFetchRequestHeaders(
      init,
      initMaybeCoerced,
      mergedInit,
      inputRequest,
      origin,
    );
    setFetchReferrerHeader(requestHeaders, initMaybeCoerced, inputRequest, resolved, origin);
    setFetchOriginHeader(requestHeaders, origin, resolved, inputRequest, mergedInit);
    mergedInit.headers = requestHeaders;
    const redirectMode = validateFetchRequest(initMaybeCoerced, inputRequest, mergedInit);
    resolved = await snapshotFetchRequestBody(resolved, inputRequest, mergedInit);
    const response = await fetchWithInternalRetry(realFetch, resolved, mergedInit);
    await throwIfBlockedResponse(response);
    const hopStart = requestUrlString(resolved, inputRequest);
    const followed = await followRedirects(realFetch, response, hopStart, {
      pageOrigin: origin,
      headers: requestHeaders,
      init: mergedInit,
      redirectMode,
      mode: String(mergedInit.mode ?? inputRequest?.mode ?? "cors"),
      inputRequest,
    });
    return finalizeFetchResponse(followed.response, followed, resolved, inputRequest, mergedInit);
  };

  (globalThis as { fetch: typeof fetch }).fetch = async function fetch(
    input: FetchInput,
    init?: FetchInit,
  ): Promise<Response> {
    try {
      return await kitesurfFetchImpl(input, init);
    } catch (error) {
      if (shouldPassThroughFetchError(error, init, input)) throw error;
      logFetchNetworkError(error);
      throw new TypeError("Failed to fetch");
    }
  };
}
