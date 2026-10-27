// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Finds and preloads bounded WebAssembly modules referenced by page scripts.

import type { SandboxOutboundOverride } from "./outbound.ts";
import { localTraceParentProps } from "../tracing-local.ts";
import { readCapped } from "../read-capped.ts";
import { walkRedirects } from "./redirect-walk.ts";

export interface WasmBakeManifestEntry {
  size: number;
  sha256: string;
  head16: string;
  tail16: string;
  bytesB64?: string;
}

export interface WasmBake {
  modules: Record<string, ArrayBuffer>;
  manifest: Record<string, WasmBakeManifestEntry>;
  errors: Record<string, string>;
}

const MAX_WASM_URLS = 8;
const MAX_TOTAL_WASM_BYTES = 48 * 1024 * 1024;
const PREFETCH_WASM_DEADLINE_MS = 10_000;
const MAX_SINGLE_WASM_BYTES = MAX_TOTAL_WASM_BYTES;
const TINY_MODULE_MAX_BYTES = 64;
const MAX_INLINE_WASM_LABEL_PREFIX_CHARS = 24;
const MAX_WASM_LITERAL_SPECIFIER_CHARS = 512;

const WASM_LITERAL_RE = new RegExp(
  "[\"'`]([^\"'`\\s]{1," + MAX_WASM_LITERAL_SPECIFIER_CHARS + "}\\.wasm)[\"'`]",
  "g",
);

const INLINE_WASM_B64_PREFIX = "AGFzbQEAAAA";
const INLINE_WASM_B64_RE = new RegExp(
  "[\"'`](" + INLINE_WASM_B64_PREFIX + "[A-Za-z0-9+/]*={0,2})[\"'`]",
  "g",
);
const MIN_WASM_BYTES = 8;

function inlineWasmKey(sha256: string): string {
  return "inline-wasm:sha256:" + sha256;
}

export function scanForInlineWasm(sources: Array<{ body: string }>): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const { body } of sources) {
    if (!body || body.indexOf("WebAssembly") === -1) continue;
    if (body.indexOf(INLINE_WASM_B64_PREFIX) === -1) continue;
    INLINE_WASM_B64_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = INLINE_WASM_B64_RE.exec(body)) !== null) {
      const lit = m[1];
      if (!lit || seen.has(lit)) continue;
      seen.add(lit);
      found.push(lit);
      if (found.length >= MAX_WASM_URLS) return found;
    }
  }
  return found;
}

function existingWasmBytes(bake: WasmBake): number {
  let totalBytes = 0;
  for (const buffer of Object.values(bake.modules)) totalBytes += buffer.byteLength;
  return totalBytes;
}

function decodeInlineWasm(
  literal: string,
  label: string,
  bake: WasmBake,
  totalBytes: number,
): Uint8Array<ArrayBuffer> | null {
  const binary = atob(literal);
  if (binary.length < MIN_WASM_BYTES) {
    bake.errors[label] = "skipped: shorter than the wasm preamble";
    return null;
  }
  if (binary.length > MAX_TOTAL_WASM_BYTES - totalBytes) {
    bake.errors[label] = "skipped: total .wasm bake budget exceeded";
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isInvalidWasmBuffer(buffer: ArrayBuffer): boolean {
  try {
    if (
      typeof WebAssembly !== "undefined" &&
      typeof WebAssembly.validate === "function" &&
      !WebAssembly.validate(buffer)
    ) {
      return true;
    }
  } catch {}
  return false;
}

async function storeInlineWasm(
  bytes: Uint8Array<ArrayBuffer>,
  bake: WasmBake,
  totalBytes: number,
): Promise<number> {
  const buffer = bytes.buffer;
  const hash = await sha256Hex(buffer);
  const key = inlineWasmKey(hash);
  if (Object.prototype.hasOwnProperty.call(bake.modules, key)) return totalBytes;
  const entry: WasmBakeManifestEntry = {
    size: buffer.byteLength,
    sha256: hash,
    head16: b64(bytes.subarray(0, 16)),
    tail16: b64(bytes.subarray(Math.max(0, bytes.length - 16))),
  };
  if (buffer.byteLength <= TINY_MODULE_MAX_BYTES) entry.bytesB64 = b64(bytes);
  bake.modules[key] = buffer;
  bake.manifest[key] = entry;
  return totalBytes + buffer.byteLength;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function bakeInlineWasmLiteral(
  literal: string,
  bake: WasmBake,
  totalBytes: number,
): Promise<number> {
  const label = "inline-wasm@" + literal.slice(0, MAX_INLINE_WASM_LABEL_PREFIX_CHARS) + "…";
  if (Object.keys(bake.modules).length >= MAX_WASM_URLS) {
    bake.errors[label] = "skipped: wasm bake module-count cap reached";
    return totalBytes;
  }
  try {
    const bytes = decodeInlineWasm(literal, label, bake, totalBytes);
    if (bytes === null) return totalBytes;
    if (isInvalidWasmBuffer(bytes.buffer)) {
      bake.errors[label] = "skipped: failed WebAssembly.validate";
      return totalBytes;
    }
    return await storeInlineWasm(bytes, bake, totalBytes);
  } catch (error) {
    bake.errors[label] = errorMessage(error);
    return totalBytes;
  }
}

export async function bakeInlineWasm(literals: string[], bake: WasmBake): Promise<WasmBake> {
  let totalBytes = existingWasmBytes(bake);
  for (const literal of literals) {
    totalBytes = await bakeInlineWasmLiteral(literal, bake, totalBytes);
  }
  return bake;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
}

function sha256Hex(buf: ArrayBuffer): Promise<string> {
  return crypto.subtle.digest("SHA-256", buf).then((d) => {
    const u8 = new Uint8Array(d);
    let hex = "";
    for (const byte of u8) hex += byte.toString(16).padStart(2, "0");
    return hex;
  });
}

function resolveWasmLiteralUrl(literal: string | undefined, baseUrl: string): string | null {
  if (!literal) return null;
  let absoluteUrl: string;
  try {
    absoluteUrl = new URL(literal, baseUrl || undefined).toString();
  } catch {
    return null;
  }
  if (!/^https?:/.test(absoluteUrl)) return null;
  return absoluteUrl;
}

function recordWasmUrl(
  literal: string | undefined,
  baseUrl: string,
  found: string[],
  seen: Set<string>,
): boolean {
  const absoluteUrl = resolveWasmLiteralUrl(literal, baseUrl);
  if (absoluteUrl === null) return false;
  if (seen.has(absoluteUrl)) return false;
  seen.add(absoluteUrl);
  found.push(absoluteUrl);
  return found.length >= MAX_WASM_URLS;
}

function scanWasmSource(
  body: string,
  baseUrl: string,
  found: string[],
  seen: Set<string>,
): boolean {
  if (!body || body.indexOf("WebAssembly") === -1) return false;
  WASM_LITERAL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WASM_LITERAL_RE.exec(body)) !== null) {
    if (recordWasmUrl(match[1], baseUrl, found, seen)) return true;
  }
  return false;
}

export function scanForWasmUrls(sources: Array<{ body: string; baseUrl: string }>): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const { body, baseUrl } of sources) {
    if (scanWasmSource(body, baseUrl, found, seen)) return found;
  }
  return found;
}

interface PrefetchWasmModulesOptions {
  urls: string[];
  pageUrl: string;
  connectionId: string;
  mainFrameId?: string;
  mainLoaderId?: string;
  extraHeaders?: Record<string, string>;
  cookieKey: string;
  sandboxOutbound: SandboxOutboundOverride;
}

interface NormalizedPrefetchWasmOptions {
  urls: string[];
  pageUrl: string;
  connectionId: string;
  mainFrameId: string;
  mainLoaderId: string;
  extraHeaders: Record<string, string>;
  cookieKey: string;
  sandboxOutbound: SandboxOutboundOverride;
}

function normalizePrefetchWasmOptions({
  urls,
  pageUrl,
  connectionId,
  mainFrameId = "",
  mainLoaderId = "",
  extraHeaders = {},
  cookieKey,
  sandboxOutbound,
}: PrefetchWasmModulesOptions): NormalizedPrefetchWasmOptions {
  return {
    urls,
    pageUrl,
    connectionId,
    mainFrameId,
    mainLoaderId,
    extraHeaders,
    cookieKey,
    sandboxOutbound,
  };
}

interface WasmPrefetchContext {
  options: NormalizedPrefetchWasmOptions;
  pageOrigin: string;
  bake: WasmBake;
  outbound: Fetcher;
  totalBytes: { value: number };
  deadlineCtrl: AbortController;
}

function pageOriginFromUrl(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    return url.protocol + "//" + url.host;
  } catch {
    return null;
  }
}

function noteUnparsablePageUrl(bake: WasmBake, urls: string[], pageUrl: string): void {
  for (const url of urls) bake.errors[url] = "unparsable page URL: " + pageUrl;
}

function isCrossOriginWasmUrl(wasmUrl: string, pageUrl: string): boolean {
  try {
    return new URL(wasmUrl).origin !== new URL(pageUrl).origin;
  } catch {
    return false;
  }
}

function wasmRequestHeaders(wasmUrl: string, context: WasmPrefetchContext): Record<string, string> {
  const { options, pageOrigin } = context;
  const headers: Record<string, string> = {
    "x-kitesurf-resource-type": "Fetch",
    "x-kitesurf-initiator": "wasm-prefetch",
    "x-kitesurf-page-origin": pageOrigin,
  };
  if (options.connectionId) headers["x-kitesurf-connection-id"] = options.connectionId;
  if (options.mainFrameId) headers["x-kitesurf-frame-id"] = options.mainFrameId;
  if (isCrossOriginWasmUrl(wasmUrl, options.pageUrl)) headers.origin = pageOrigin;
  return headers;
}

async function fetchWasmResponse(
  wasmUrl: string,
  signal: AbortSignal,
  headers: Record<string, string>,
  context: WasmPrefetchContext,
): Promise<Response | null> {
  const walk = await walkRedirects({
    url: wasmUrl,
    signal,
    headers,
    taintOriginFrom: context.pageOrigin || undefined,
    fetchHop: (request) => context.outbound.fetch(request),
  });
  if (!walk.ok) {
    context.bake.errors[wasmUrl] = ".wasm fetch too many redirects";
    return null;
  }
  return walk.response;
}

async function isBakeableWasmResponse(
  wasmUrl: string,
  response: Response,
  bake: WasmBake,
): Promise<boolean> {
  const blockedReason = response.headers.get("x-kitesurf-blocked");
  if (response.status === 403 && blockedReason) {
    bake.errors[wasmUrl] = await response.text();
    return false;
  }
  if (!response.ok) {
    bake.errors[wasmUrl] = ".wasm fetch returned HTTP " + response.status;
    return false;
  }
  return true;
}

function contentLengthOverWasmBudget(response: Response, remaining: number): number | null {
  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : Number.NaN;
  return Number.isFinite(contentLength) && contentLength > remaining ? contentLength : null;
}

async function readWasmResponseBytes(
  wasmUrl: string,
  response: Response,
  context: WasmPrefetchContext,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const remaining = MAX_TOTAL_WASM_BYTES - context.totalBytes.value;
  const overBudgetBytes = contentLengthOverWasmBudget(response, remaining);
  if (overBudgetBytes !== null) {
    context.bake.errors[wasmUrl] =
      "skipped: total .wasm bake budget exceeded (" + overBudgetBytes + " bytes over cap)";
    return null;
  }
  const capped = await readCapped(response.body, Math.min(remaining, MAX_SINGLE_WASM_BYTES));
  if (capped.bytes === null) {
    await capped.rest.cancel().catch(() => {});
    context.bake.errors[wasmUrl] =
      capped.failure === "error"
        ? "skipped: .wasm body failed mid-stream"
        : "skipped: exceeded .wasm bake byte budget mid-stream";
    return null;
  }
  return capped.bytes;
}

async function storeFetchedWasm(
  wasmUrl: string,
  bytes: Uint8Array<ArrayBuffer>,
  context: WasmPrefetchContext,
): Promise<void> {
  const buffer = bytes.buffer;
  context.totalBytes.value += buffer.byteLength;
  const view = new Uint8Array(buffer);
  const entry: WasmBakeManifestEntry = {
    size: buffer.byteLength,
    sha256: await sha256Hex(buffer),
    head16: b64(view.subarray(0, 16)),
    tail16: b64(view.subarray(Math.max(0, view.length - 16))),
  };
  if (buffer.byteLength <= TINY_MODULE_MAX_BYTES) entry.bytesB64 = b64(view);
  context.bake.modules[wasmUrl] = buffer;
  context.bake.manifest[wasmUrl] = entry;
}

async function fetchAndStoreWasm(
  wasmUrl: string,
  signal: AbortSignal,
  context: WasmPrefetchContext,
): Promise<void> {
  const response = await fetchWasmResponse(
    wasmUrl,
    signal,
    wasmRequestHeaders(wasmUrl, context),
    context,
  );
  if (response === null) return;
  if (!(await isBakeableWasmResponse(wasmUrl, response, context.bake))) return;
  const bytes = await readWasmResponseBytes(wasmUrl, response, context);
  if (bytes === null) return;
  if (isInvalidWasmBuffer(bytes.buffer)) {
    context.bake.errors[wasmUrl] = "skipped: failed WebAssembly.validate";
    return;
  }
  await storeFetchedWasm(wasmUrl, bytes, context);
}

function wasmPrefetchError(deadlineExceeded: boolean, error: unknown): string {
  return deadlineExceeded
    ? ".wasm prefetch exceeded the shared navigate deadline"
    : errorMessage(error);
}

function subscribeWasmDeadline(deadline: AbortSignal, controller: AbortController): () => void {
  const onDeadline = () => controller.abort();
  deadline.addEventListener("abort", onDeadline);
  if (deadline.aborted) controller.abort();
  return onDeadline;
}

async function prefetchWasmUrl(wasmUrl: string, context: WasmPrefetchContext): Promise<void> {
  const controller = new AbortController();
  const onDeadline = subscribeWasmDeadline(context.deadlineCtrl.signal, controller);
  try {
    await fetchAndStoreWasm(wasmUrl, controller.signal, context);
  } catch (error) {
    context.bake.errors[wasmUrl] = wasmPrefetchError(context.deadlineCtrl.signal.aborted, error);
  } finally {
    context.deadlineCtrl.signal.removeEventListener("abort", onDeadline);
  }
}

export async function prefetchWasmModules(
  rawOptions: PrefetchWasmModulesOptions,
): Promise<WasmBake> {
  const {
    urls,
    pageUrl,
    connectionId,
    mainFrameId,
    mainLoaderId,
    extraHeaders,
    cookieKey,
    sandboxOutbound,
  } = normalizePrefetchWasmOptions(rawOptions);
  const bake: WasmBake = { modules: {}, manifest: {}, errors: {} };
  if (urls.length === 0) return bake;

  const pageOrigin = pageOriginFromUrl(pageUrl);
  if (pageOrigin === null) {
    noteUnparsablePageUrl(bake, urls, pageUrl);
    return bake;
  }

  const outbound = sandboxOutbound.parent({
    ...localTraceParentProps(),
    pageOrigin,
    mainFrameId,
    mainLoaderId,
    extraHeaders,
    connectionId,
    cookieKey,
  });

  const deadlineCtrl = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineCtrl.abort(), PREFETCH_WASM_DEADLINE_MS);
  const context: WasmPrefetchContext = {
    options: {
      urls,
      pageUrl,
      connectionId,
      mainFrameId,
      mainLoaderId,
      extraHeaders,
      cookieKey,
      sandboxOutbound,
    },
    pageOrigin,
    bake,
    outbound,
    totalBytes: { value: 0 },
    deadlineCtrl,
  };
  try {
    await Promise.all(urls.map((wasmUrl) => prefetchWasmUrl(wasmUrl, context)));
  } finally {
    clearTimeout(deadlineTimer);
  }
  return bake;
}
