// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Fetches page subresources and tracks the work that participates in load settlement.
// Work in `resourceInflight` holds back load settlement until the drain in `index.ts` sees quiet.

import {
  KITESURF_CORS_VERDICT_HEADER,
  KITESURF_NOSNIFF_HEADER,
  responseIsOpaque,
} from "@kitesurf/script-gate/gateway-headers";
import { __setBridgeFetchResource } from "./wasm-glue.js";
import {
  CLASS_IMAGE_VIEWPORT,
  FetchSlots,
  allHintsLazy,
  classForImageHints,
  classForKind,
} from "./fetch-slots.ts";
import { NativePromise } from "./native-scheduling.ts";
import { getInternalState } from "./internal-state.js";
import { cascadeSeq, invalidatePaintDom } from "./paint.ts";
import { noteSyncOp } from "./lag-monitor.ts";
import { responseHeaderGet } from "./native-http.ts";
import { state } from "./state.ts";
import { trustedFetch } from "./trusted-fetch.ts";
import {
  fontDeferActive,
  fontDemandFired,
  setParkedFontReleaseHook,
  fontLoaderMode,
} from "./font-loader.ts";

const fontCustody = new Map<string, Uint8Array>();
let fontCustodyBytes = 0;
const FONT_CUSTODY_BUDGET = 8 * 1024 * 1024;

const fontKeyUrls = new Map<string, string>();
const NODE_ATTRIBUTE_PAIR_WIDTH = 2;
const NODE_ATTRIBUTE_VALUE_OFFSET = 1;
const DATA_URL_PREFIX_LENGTH = 5;
const DATA_URL_PERCENT_SIGN_CODE_POINT = 0x25;
const DATA_URL_PLUS_SIGN_CODE_POINT = 0x2b;
const DATA_URL_SPACE_CODE_POINT = 0x20;
const DATA_URL_HEX_RADIX = 16;
const DATA_URL_BYTE_MASK = 0xff;

export function fontUrlForKey(key: string): string {
  return fontKeyUrls.get(key) ?? "";
}

export async function resolveFontUrlData(url: string): Promise<Uint8Array | null> {
  const held = fontCustody.get(url);
  if (held) {
    fontCustody.delete(url);
    fontCustodyBytes -= held.length;
    return held;
  }
  if (url.startsWith("data:")) return decodeFontDataUrl(url);
  const fetchResult = await doRealFetch(url, "Font");
  return fetchResult.ok ? fetchResult.bytes : null;
}

function decodeFontDataUrl(url: string): Uint8Array | null {
  try {
    const comma = url.indexOf(",");
    if (comma < 0) return null;
    const meta = url.slice(DATA_URL_PREFIX_LENGTH, comma);
    const payload = url.slice(comma + 1);
    if (/;base64/i.test(meta)) return decodeBase64Payload(payload);
    return decodePercentPayload(payload);
  } catch {
    return null;
  }
}

function decodeBase64Payload(payload: string): Uint8Array {
  const binary = atob(payload.replace(/\s+/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function dataHexPair(payload: string, index: number, characterCode: number): string | null {
  if (characterCode !== DATA_URL_PERCENT_SIGN_CODE_POINT) return null;
  if (index + 2 >= payload.length) return null;
  const pair = payload.slice(index + 1, index + 3);
  return /^[0-9a-fA-F]{2}$/.test(pair) ? pair : null;
}

function dataByteFromCharacter(characterCode: number): number {
  return characterCode === DATA_URL_PLUS_SIGN_CODE_POINT
    ? DATA_URL_SPACE_CODE_POINT
    : characterCode & DATA_URL_BYTE_MASK;
}

function dataPayloadByte(payload: string, index: number): { byte: number; consumed: number } {
  const characterCode = payload.charCodeAt(index);
  const hexPair = dataHexPair(payload, index, characterCode);
  if (hexPair !== null) {
    return { byte: parseInt(hexPair, DATA_URL_HEX_RADIX), consumed: 2 };
  }
  return { byte: dataByteFromCharacter(characterCode), consumed: 0 };
}

function decodePercentPayload(payload: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < payload.length; index++) {
    const decoded = dataPayloadByte(payload, index);
    bytes.push(decoded.byte);
    index += decoded.consumed;
  }
  return Uint8Array.from(bytes);
}

export const resourceCacheStyles = new Map<string, string>();

export const stylesheetCors = new Map<string, "clean" | "opaque">();

type StylesheetDom = {
  nodeInfo?: (id: number) => { attributes?: unknown[] } | null;
  baseURL?: () => string;
};

function hrefFromAttributes(attrs: unknown[]): string {
  for (
    let index = 0;
    index + NODE_ATTRIBUTE_VALUE_OFFSET < attrs.length;
    index += NODE_ATTRIBUTE_PAIR_WIDTH
  ) {
    if (String(attrs[index] ?? "").toLowerCase() === "href") {
      return String(attrs[index + NODE_ATTRIBUTE_VALUE_OFFSET] ?? "");
    }
  }
  return "";
}

function stylesheetHref(dom: StylesheetDom, nodeId: number): string | null {
  if (typeof dom.nodeInfo !== "function") return null;
  try {
    const attrs = dom.nodeInfo(nodeId)?.attributes;
    return Array.isArray(attrs) ? hrefFromAttributes(attrs) : "";
  } catch {
    return null;
  }
}

function resolveStylesheetHref(dom: StylesheetDom, href: string): string | null {
  try {
    const base = (dom.baseURL && dom.baseURL()) || "about:blank";
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function cachedStylesheetResult(
  resolved: string,
): { state: "clean"; text: string } | { state: "denied" } | { state: "pending" } {
  const verdict = stylesheetCors.get(resolved);
  if (verdict === undefined) return { state: "pending" };
  if (verdict !== "clean") return { state: "denied" };
  const text = resourceCacheStyles.get(resolved);
  if (text === undefined) return { state: "pending" };
  return { state: "clean", text };
}

export function externalSheetRulesForNode(
  nodeId: number,
): { state: "clean"; text: string } | { state: "denied" } | { state: "pending" } {
  const dom = state.dom as StylesheetDom | null;
  if (!dom?.nodeInfo) return { state: "pending" };
  const href = stylesheetHref(dom, nodeId);
  if (!href) return { state: "pending" };
  const resolved = resolveStylesheetHref(dom, href);
  if (!resolved) return { state: "pending" };
  return cachedStylesheetResult(resolved);
}

const STYLESHEET_CACHE_MAX = 32;

class InflightSet extends Set<string> {
  override delete(value: string): boolean {
    const removed = super.delete(value);
    if (removed && blockingInflightCount() === 0) notifyInflightZero();
    return removed;
  }
}

let inflightZeroWaiters: Array<() => void> = [];

function notifyInflightZero(): void {
  const waiters = inflightZeroWaiters;
  inflightZeroWaiters = [];
  for (const resolveWaiter of waiters) resolveWaiter();
}

export function waitForInflightZero(): Promise<void> {
  if (blockingInflightCount() === 0) return NativePromise.resolve();
  return new NativePromise<void>((resolve) => {
    inflightZeroWaiters.push(resolve);
  });
}

let resourceSettleWaiters: Array<() => void> = [];

export function nextResourceSettle(): Promise<void> {
  return new NativePromise<void>((resolve) => {
    resourceSettleWaiters.push(resolve);
  });
}

export const resourceInflight = new InflightSet();
const inflightRefcount = new Map<string, number>();

export const inflightStartedAt = new Map<string, number>();

const fontInflightRefcount = new Map<string, number>();
const fontWaiters: Array<() => void> = [];

const imageInflightRefcount = new Map<string, number>();

function addImageInflight(url: string): void {
  imageInflightRefcount.set(url, (imageInflightRefcount.get(url) ?? 0) + 1);
}

function removeImageInflight(url: string): void {
  const remaining = (imageInflightRefcount.get(url) ?? 1) - 1;
  if (remaining <= 0) {
    imageInflightRefcount.delete(url);
  } else {
    imageInflightRefcount.set(url, remaining);
  }
}

export function isImageInflight(url: string): boolean {
  return imageInflightRefcount.has(url);
}

export function imageInflightUrls(): string[] {
  return Array.from(imageInflightRefcount.keys());
}

function addFontInflight(url: string): void {
  const refCount = (fontInflightRefcount.get(url) ?? 0) + 1;
  fontInflightRefcount.set(url, refCount);
}

function removeFontInflight(url: string): void {
  const remaining = (fontInflightRefcount.get(url) ?? 1) - 1;
  if (remaining > 0) {
    fontInflightRefcount.set(url, remaining);
    return;
  }
  fontInflightRefcount.delete(url);
  if (fontInflightRefcount.size !== 0) return;
  resolveFontWaiters();
}

function resolveFontWaiters(): void {
  const drained = fontWaiters.splice(0, fontWaiters.length);
  for (const resolveWaiter of drained) {
    try {
      resolveWaiter();
    } catch {}
  }
}

export function fontsInflightCount(): number {
  return fontInflightRefcount.size;
}

export function fontsIdle(): Promise<void> {
  if (fontInflightRefcount.size === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    fontWaiters.push(resolve);
  });
}

let stylesheetDeliverySeq = 0;

export function getStylesheetDeliverySeq(): number {
  return stylesheetDeliverySeq;
}

const fetchPhaseStats = {
  count: 0,
  errors: 0,
  slotMs: 0,
  fetchMs: 0,
  headersMs: 0,
  deliverMs: 0,
  maxSlotMs: 0,
  maxFetchMs: 0,
  maxDeliverMs: 0,
};
const SLOW_FETCH_WARNING_MS = 2_000;

export function snapshotFetchStats(): Record<string, number> {
  const slots = fetchSlots.stats();
  return {
    ...fetchPhaseStats,
    slotUncontended: slots.uncontended,
    slotMisorder30: slots.misorderHits,
  };
}

function recordDeliverMs(ms: number): void {
  fetchPhaseStats.deliverMs += ms;
  if (ms > fetchPhaseStats.maxDeliverMs) fetchPhaseStats.maxDeliverMs = ms;
}

function cacheStylesheet(url: string, bytes: Uint8Array): void {
  try {
    const css = new TextDecoder("utf-8").decode(bytes);
    if (resourceCacheStyles.size >= STYLESHEET_CACHE_MAX) {
      const oldest = resourceCacheStyles.keys().next().value;
      if (oldest !== undefined) resourceCacheStyles.delete(oldest);
    }
    resourceCacheStyles.set(url, css);
  } catch {}
}

function warnFontDelivery(id: number, ok: boolean, url: string): void {
  try {
    console.warn(`[ks-fonts] deliver id=${id} ok=${ok}: ${url}`);
  } catch {}
}

function markResourceDelivered(
  internalState: ReturnType<typeof getInternalState>,
  kind: string,
  url: string,
): void {
  internalState.mutationSeq = (internalState.mutationSeq | 0) + 1;
  if (kind === "Stylesheet") {
    internalState.styleSheetsDirty = true;
    stylesheetDeliverySeq++;
    try {
      state.notifyStylesheetResults(url, true);
    } catch {}
  } else {
    internalState.paintNeutralSeq = (internalState.paintNeutralSeq | 0) + 1;
  }
}

function addInflight(url: string): void {
  const refCount = (inflightRefcount.get(url) ?? 0) + 1;
  inflightRefcount.set(url, refCount);
  if (refCount === 1) {
    resourceInflight.add(url);
    inflightStartedAt.set(url, Date.now());
  }
}

function removeInflight(url: string): void {
  const remaining = (inflightRefcount.get(url) ?? 1) - 1;
  if (remaining <= 0) {
    inflightRefcount.delete(url);
    resourceInflight.delete(url);
    inflightStartedAt.delete(url);
    deferredUrls.delete(url);
  } else {
    inflightRefcount.set(url, remaining);
  }
}

const fetchSlots = new FetchSlots();
const releaseFetchSlot = (url: string): void => fetchSlots.release(url);

const deferredUrls = new Set<string>();

// Lazy image fetches stay tracked, but do not hold the document's load event.
export function blockingInflightCount(): number {
  let blockingCount = 0;
  for (const url of resourceInflight) {
    if (!deferredUrls.has(url)) blockingCount++;
  }
  return blockingCount;
}

function collectImageHints(url: string): Array<{ priority: string; lazy: boolean }> | null {
  const dom = imageHintDom();
  if (!dom) return null;
  const hints: Array<{ priority: string; lazy: boolean }> = [];
  try {
    for (const id of Array.from(dom.pendingImageNodes(url))) {
      hints.push(imageHintsForNode(dom, id));
    }
  } catch {
    return null;
  }
  return hints;
}

type ImageHint = { priority: string; lazy: boolean };
type ImageHintDom = {
  pendingImageNodes?: (url: string) => ArrayLike<number>;
  nodeInfo?: (id: number) => { attributes?: unknown[] } | null;
};
type ReadyImageHintDom = ImageHintDom & {
  pendingImageNodes: NonNullable<ImageHintDom["pendingImageNodes"]>;
  nodeInfo: NonNullable<ImageHintDom["nodeInfo"]>;
};

function isReadyImageHintDom(dom: ImageHintDom | null): dom is ReadyImageHintDom {
  return !!dom?.pendingImageNodes && !!dom.nodeInfo;
}

function imageHintDom(): ReadyImageHintDom | null {
  const dom = state.dom as ImageHintDom | null;
  return isReadyImageHintDom(dom) ? dom : null;
}

function nodeAttributeName(attrs: unknown[], index: number): string {
  return String(attrs[index] ?? "").toLowerCase();
}

function nodeAttributeValue(attrs: unknown[], index: number): string {
  return String(attrs[index + NODE_ATTRIBUTE_VALUE_OFFSET] ?? "");
}

function imageHintsForNode(dom: ImageHintDom, id: number): ImageHint {
  const attrs = dom.nodeInfo?.(id)?.attributes;
  if (!Array.isArray(attrs)) return { priority: "", lazy: false };
  return imageHintsFromAttributes(attrs);
}

function updateImageHint(attrs: unknown[], index: number, hint: ImageHint): void {
  const name = nodeAttributeName(attrs, index);
  if (name === "fetchpriority") {
    hint.priority = nodeAttributeValue(attrs, index).toLowerCase();
    return;
  }
  if (name === "loading") {
    hint.lazy = nodeAttributeValue(attrs, index).toLowerCase() === "lazy";
  }
}

function imageHintsFromAttributes(attrs: unknown[]): ImageHint {
  const hint: ImageHint = { priority: "", lazy: false };
  for (
    let index = 0;
    index + NODE_ATTRIBUTE_VALUE_OFFSET < attrs.length;
    index += NODE_ATTRIBUTE_PAIR_WIDTH
  ) {
    updateImageHint(attrs, index, hint);
  }
  return hint;
}

function reevaluateDeferred(url: string): void {
  if (!deferredUrls.has(url)) return;
  const hints = collectImageHints(url);
  if (hints !== null && !allHintsLazy(hints)) {
    deferredUrls.delete(url);
  }
}

export function reevaluateDeferredUrls(): void {
  for (const url of Array.from(deferredUrls)) {
    reevaluateDeferred(url);
  }
}

let iframeDocumentHintSeq = -1;
let iframeDocumentHintDom: unknown = null;
let iframeDocumentHints = new Map<string, { lazy: boolean; crossOrigin: boolean }>();

type IframeHint = { lazy: boolean; crossOrigin: boolean };
type IframeDom = {
  querySelectorAll?: (selector: string) => ArrayLike<number>;
  nodeInfo?: (id: number) => { attributes?: unknown[] } | null;
  baseURL?: () => string;
};
type ReadyIframeDom = IframeDom & {
  querySelectorAll: NonNullable<IframeDom["querySelectorAll"]>;
  nodeInfo: NonNullable<IframeDom["nodeInfo"]>;
};

function isReadyIframeDom(dom: IframeDom | null): dom is ReadyIframeDom {
  return !!dom?.querySelectorAll && !!dom.nodeInfo;
}

function iframeElementHints(attrs: unknown[]): { src: string; lazy: boolean } {
  let src = "";
  let lazy = false;
  for (
    let index = 0;
    index + NODE_ATTRIBUTE_VALUE_OFFSET < attrs.length;
    index += NODE_ATTRIBUTE_PAIR_WIDTH
  ) {
    const name = nodeAttributeName(attrs, index);
    if (name === "src") {
      src = nodeAttributeValue(attrs, index);
    }
    if (name === "loading") {
      lazy = nodeAttributeValue(attrs, index).toLowerCase() === "lazy";
    }
  }
  return { src, lazy };
}

function resolveIframeSource(src: string, base: string): string | null {
  try {
    return new URL(src, base).href;
  } catch {
    return null;
  }
}

function iframeIsCrossOrigin(resolved: string, baseOrigin: string): boolean {
  return resolved !== "about:blank" && new URL(resolved).origin !== baseOrigin;
}

function mergedIframeLazy(previous: IframeHint | undefined, lazy: boolean): boolean {
  return (previous?.lazy ?? true) && lazy;
}

function addIframeDocumentHint(
  dom: ReadyIframeDom,
  id: number,
  base: string,
  baseOrigin: string,
  hints: Map<string, IframeHint>,
): void {
  const attrs = dom.nodeInfo(id)?.attributes;
  if (!Array.isArray(attrs)) return;
  const { src, lazy } = iframeElementHints(attrs);
  if (!src) return;
  const resolved = resolveIframeSource(src, base);
  if (!resolved) return;
  const previous = hints.get(resolved);
  hints.set(resolved, {
    lazy: mergedIframeLazy(previous, lazy),
    crossOrigin: iframeIsCrossOrigin(resolved, baseOrigin),
  });
}

function scanIframeDocumentHints(dom: ReadyIframeDom): Map<string, IframeHint> | null {
  const hints = new Map<string, IframeHint>();
  try {
    const base = dom.baseURL?.() || "about:blank";
    const baseOrigin = new URL(base).origin;
    for (const id of Array.from(dom.querySelectorAll("iframe"))) {
      addIframeDocumentHint(dom, id, base, baseOrigin, hints);
    }
  } catch {
    return null;
  }
  return hints;
}

function iframeDocumentDom(): ReadyIframeDom | null {
  const dom = state.dom as IframeDom | null;
  return isReadyIframeDom(dom) ? dom : null;
}

function iframeHintCacheMatches(dom: ReadyIframeDom, seq: number): boolean {
  return dom === iframeDocumentHintDom && seq === iframeDocumentHintSeq;
}

function cachedIframeHint(url: string): IframeHint | null {
  return iframeDocumentHints.get(url) ?? null;
}

function cacheIframeDocumentHints(
  dom: ReadyIframeDom,
  seq: number,
  hints: Map<string, IframeHint>,
): void {
  iframeDocumentHintDom = dom;
  iframeDocumentHintSeq = seq;
  iframeDocumentHints = hints;
}

function iframeDocumentHint(url: string): IframeHint | null {
  const dom = iframeDocumentDom();
  if (!dom) return null;
  const seq = getInternalState().mutationSeq | 0;
  if (iframeHintCacheMatches(dom, seq)) return cachedIframeHint(url);
  const hints = scanIframeDocumentHints(dom);
  if (!hints) return null;
  cacheIframeDocumentHints(dom, seq, hints);
  return hints.get(url) ?? null;
}

async function acquireFetchSlot(url: string, kind: string): Promise<void> {
  await NativePromise.resolve();
  let resourceClass = classForKind(kind);
  if (kind === "Image") {
    const hints = collectImageHints(url);
    if (hints !== null) {
      resourceClass = classForImageHints(hints);
      if (allHintsLazy(hints)) {
        deferredUrls.add(url);
        if (blockingInflightCount() === 0) notifyInflightZero();
      }
    }
  }
  return fetchSlots.acquire(url, resourceClass);
}

const boostVerdicts = new Map<string, number | null>();
let boostVerdictSeq = -1;
let boostFlushedAt = 0;
const BOOST_VERDICT_MAX_AGE_MS = 100;

function hasPendingCriticalResources(): boolean {
  try {
    const dom = state.dom as { hasPendingCriticalResources?: () => boolean } | null;
    return Boolean(dom?.hasPendingCriticalResources?.());
  } catch {
    return true;
  }
}

function canProbeImageBoost(): boolean {
  return state.paintCacheHandle !== null && !hasPendingCriticalResources();
}

type BoostVerdictLookup = { cached: true; verdict: number | null } | { cached: false };

function cachedBoostVerdict(url: string, cascadeSequence: number): BoostVerdictLookup {
  if (cascadeSequence !== boostVerdictSeq) {
    const now = Date.now();
    if (now - boostFlushedAt < BOOST_VERDICT_MAX_AGE_MS) {
      const stale = boostVerdicts.get(url);
      return { cached: true, verdict: stale ?? null };
    }
    boostVerdicts.clear();
    boostVerdictSeq = cascadeSequence;
    boostFlushedAt = now;
  }
  const cached = boostVerdicts.get(url);
  return cached === undefined ? { cached: false } : { cached: true, verdict: cached };
}

type PendingImageDom = {
  pendingImageNodes?: (url: string) => ArrayLike<number>;
  getBoundingClientRect?: (
    id: number,
  ) => { x?: number; y?: number; width?: number; height?: number } | null;
};
type ReadyPendingImageDom = PendingImageDom & {
  pendingImageNodes: NonNullable<PendingImageDom["pendingImageNodes"]>;
  getBoundingClientRect: NonNullable<PendingImageDom["getBoundingClientRect"]>;
};

function isReadyPendingImageDom(dom: PendingImageDom | null): dom is ReadyPendingImageDom {
  return !!dom?.pendingImageNodes && !!dom.getBoundingClientRect;
}

function pendingImageDom(): ReadyPendingImageDom | null {
  const dom = state.dom as PendingImageDom | null;
  return isReadyPendingImageDom(dom) ? dom : null;
}

function pendingImageIntersectsViewport(
  range: { x?: number; y?: number; width?: number; height?: number },
  viewportX: number,
  viewportY: number,
  viewportWidth: number,
  viewportHeight: number,
): boolean {
  const rangeX = rectCoordinate(range.x);
  const rangeY = rectCoordinate(range.y);
  const width = rectCoordinate(range.width);
  const height = rectCoordinate(range.height);
  return (
    rangeX < viewportX + viewportWidth &&
    rangeX + width > viewportX &&
    rangeY < viewportY + viewportHeight &&
    rangeY + height > viewportY
  );
}

function rectCoordinate(value: number | undefined): number {
  return Number(value) || 0;
}

function visiblePendingImageVerdict(dom: ReadyPendingImageDom, url: string): number | null {
  let verdict: number | null = null;
  try {
    const viewportX = state.scrollX;
    const viewportY = state.scrollY;
    const viewportWidth = state.paintViewportW;
    const viewportHeight = state.paintViewportH;
    for (const id of Array.from(dom.pendingImageNodes(url))) {
      const range = dom.getBoundingClientRect(id);
      if (!range) continue;
      if (
        pendingImageIntersectsViewport(range, viewportX, viewportY, viewportWidth, viewportHeight)
      ) {
        verdict = CLASS_IMAGE_VIEWPORT;
        break;
      }
    }
  } catch {
    invalidatePaintDom();
    verdict = null;
  }
  return verdict;
}

function probeImageBoost(url: string): number | null {
  if (!canProbeImageBoost()) return null;
  const cache = cachedBoostVerdict(url, cascadeSeq() | 0);
  if (cache.cached) return cache.verdict;
  const dom = pendingImageDom();
  if (!dom) return null;
  const verdict = visiblePendingImageVerdict(dom, url);
  boostVerdicts.set(url, verdict);
  return verdict;
}

fetchSlots.setBoostProbe(probeImageBoost);

type FetchResult =
  | {
      ok: true;
      bytes: Uint8Array;
      opaqueImage: OpaqueImage | null;
      cors: "clean" | "opaque";
      fontKey: string;
    }
  | { ok: false };

type OpaqueImage = { key: string; w: number; h: number };

const RESOURCE_KEY_HEADER = "x-kitesurf-resource-key";
const IMAGE_WIDTH_HEADER = "x-kitesurf-image-width";
const IMAGE_HEIGHT_HEADER = "x-kitesurf-image-height";

const FONT_KEY_HEADER = "x-kitesurf-font-key";

function readFontKey(response: Response): string {
  const key = responseHeaderGet(response, FONT_KEY_HEADER) ?? "";
  return key === "0" || !/^[0-9]+$/.test(key) ? "" : key;
}

function readOpaqueImage(response: Response): OpaqueImage | null {
  const key = responseHeaderGet(response, RESOURCE_KEY_HEADER) ?? "";
  const width = Number(responseHeaderGet(response, IMAGE_WIDTH_HEADER) ?? "");
  const height = Number(responseHeaderGet(response, IMAGE_HEIGHT_HEADER) ?? "");
  if (key === "" || key === "0") return null;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { key, w: width, h: height };
}

const inflightFetches = new Map<string, Promise<FetchResult>>();

function addOptionalFetchHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  if (value) headers[name] = value;
}

function resourceFetchHeaders(kind: string, corsMode: string): Record<string, string> {
  const headers: Record<string, string> = {
    "x-kitesurf-allow-cross-origin": "1",
  };
  if (kind === "Stylesheet" && corsMode) {
    headers["x-kitesurf-stylesheet-cors"] = corsMode;
  }
  addOptionalFetchHeader(headers, "x-kitesurf-connection-id", state.connectionId);
  addOptionalFetchHeader(headers, "x-kitesurf-frame-id", state.mainFrameId);
  addOptionalFetchHeader(headers, "x-kitesurf-cookie-key", state.cookieKey);
  return headers;
}

function recordFetchTimings(slotMs: number, fetchMs: number, headersMs: number): void {
  fetchPhaseStats.count++;
  fetchPhaseStats.slotMs += slotMs;
  fetchPhaseStats.fetchMs += fetchMs;
  fetchPhaseStats.headersMs += headersMs;
  if (slotMs > fetchPhaseStats.maxSlotMs) fetchPhaseStats.maxSlotMs = slotMs;
  if (fetchMs > fetchPhaseStats.maxFetchMs) fetchPhaseStats.maxFetchMs = fetchMs;
}

function warnSlowFetch(
  fetchMs: number,
  headersMs: number,
  slotMs: number,
  kind: string,
  url: string,
): void {
  if (fetchMs <= SLOW_FETCH_WARNING_MS) return;
  console.warn(
    `[ks-fetch] slow fetch: ${fetchMs}ms (headers=${headersMs}ms slot=${slotMs}ms) kind=${kind} url=${url}`,
  );
}

async function successfulFetchResult(
  response: Response,
  url: string,
  kind: string,
  queuedAt: number,
  slotStartedAt: number,
  headersMs: number,
): Promise<FetchResult> {
  const cors =
    responseHeaderGet(response, "x-kitesurf-cors") === "clean"
      ? ("clean" as const)
      : ("opaque" as const);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const slotMs = slotStartedAt - queuedAt;
  const fetchMs = Date.now() - slotStartedAt;
  recordFetchTimings(slotMs, fetchMs, headersMs);
  warnSlowFetch(fetchMs, headersMs, slotMs, kind, url);
  return {
    ok: true,
    bytes,
    opaqueImage: readOpaqueImage(response),
    cors,
    fontKey: readFontKey(response),
  };
}

async function doRealFetch(url: string, kind: string, corsMode: string = ""): Promise<FetchResult> {
  const queuedAt = Date.now();
  await acquireFetchSlot(url, kind);
  const slotStartedAt = Date.now();
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseFetchSlot(url);
  };
  try {
    const response = await trustedFetch(
      url,
      { headers: resourceFetchHeaders(kind, corsMode) },
      { resourceType: kind || "Other", initiator: "parser" },
    );
    // Release at response headers so body reads do not hold admission capacity.
    release();
    const headersMs = Date.now() - slotStartedAt;
    if (!response.ok) {
      fetchPhaseStats.errors++;
      return { ok: false };
    }
    return await successfulFetchResult(response, url, kind, queuedAt, slotStartedAt, headersMs);
  } catch {
    fetchPhaseStats.errors++;
    return { ok: false };
  } finally {
    release();
  }
}

export async function fetchInsertedScript(
  url: string,
  crossOrigin: string | null = null,
): Promise<{
  status: number;
  source: string;
  bytes: Uint8Array;
  contentType: string | null;
  nosniff: string | null;
  opaque: boolean;
}> {
  await acquireFetchSlot(url, "Script");
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    releaseFetchSlot(url);
  };
  try {
    const corsMode = crossOrigin == null ? "no-cors" : "cors";
    const headers: Record<string, string> = {
      "x-kitesurf-script-cors": corsMode,
      accept: "*/*",
    };
    if (state.connectionId) {
      headers["x-kitesurf-connection-id"] = state.connectionId;
    }
    if (state.mainFrameId) headers["x-kitesurf-frame-id"] = state.mainFrameId;
    if (state.cookieKey) headers["x-kitesurf-cookie-key"] = state.cookieKey;
    const response = await trustedFetch(
      url,
      { headers },
      { resourceType: "Script", initiator: "script" },
    );
    release();
    if (!response.ok) {
      return {
        status: response.status || 0,
        source: "",
        bytes: EMPTY_BYTES,
        contentType: null,
        nosniff: null,
        opaque: true,
      };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      source: new TextDecoder("utf-8").decode(bytes),
      bytes,
      contentType: response.headers.get("content-type"),
      nosniff: response.headers.get(KITESURF_NOSNIFF_HEADER),
      opaque: responseIsOpaque(response.headers.get(KITESURF_CORS_VERDICT_HEADER)),
    };
  } catch {
    return {
      status: 0,
      source: "",
      bytes: EMPTY_BYTES,
      contentType: null,
      nosniff: null,
      opaque: true,
    };
  } finally {
    release();
  }
}

const EMPTY_BYTES = new Uint8Array(0);

const parkedFonts: Array<{ id: number; url: string; corsMode: string }> = [];

function releaseParkedFontFetches(): void {
  const parked = parkedFonts.splice(0, parkedFonts.length);
  for (const parkedFont of parked) {
    try {
      console.warn(`[ks-fonts] @font-face unparked: ${parkedFont.url}`);
    } catch {}
    void fetchResource(parkedFont.id, parkedFont.url, "Font", parkedFont.corsMode);
  }
}
setParkedFontReleaseHook(releaseParkedFontFetches);

interface ResourceRequest {
  id: number;
  url: string;
  kind: string;
  corsMode: string;
}

interface TrackedResourceRequest extends ResourceRequest {
  blocksLoad: boolean;
}

type ResourceDisposition = { state: "skip" } | { state: "fetch"; blocksLoad: boolean };

type ResourceDom = {
  deliverResource?: (id: number, bytes: Uint8Array) => boolean;
  deliverFontResource?: (id: number, bytes: Uint8Array, key: string) => boolean;
  deliverResourceMeta?: (id: number, key: string, w: number, h: number) => boolean;
  deliverResourceError?: (id: number) => void;
};

type ReadyResourceDom = ResourceDom & {
  deliverResource: NonNullable<ResourceDom["deliverResource"]>;
};

function isReadyResourceDom(dom: ResourceDom | null): dom is ReadyResourceDom {
  return !!dom?.deliverResource;
}

type SuccessfulFetchResult = Extract<FetchResult, { ok: true }>;

function shouldParkFont(kind: string): boolean {
  return kind === "Font" && fontDeferActive() && !fontDemandFired();
}

function parkFont(request: ResourceRequest): void {
  parkedFonts.push({ id: request.id, url: request.url, corsMode: request.corsMode });
  try {
    console.warn(`[ks-fonts] @font-face parked: ${request.url}`);
  } catch {}
}

function notifyDocumentResourceError(id: number): void {
  try {
    const dom = state.dom as { deliverResourceError?: (id: number) => void } | null;
    dom?.deliverResourceError?.(id);
  } catch {}
}

function resourceDisposition(id: number, url: string, kind: string): ResourceDisposition {
  if (kind !== "Document") return { state: "fetch", blocksLoad: true };
  const hint = iframeDocumentHint(url);
  if (hint === null || hint.crossOrigin) {
    notifyDocumentResourceError(id);
    return { state: "skip" };
  }
  return { state: "fetch", blocksLoad: !hint.lazy };
}

function trackResourceStart(request: TrackedResourceRequest): void {
  if (request.blocksLoad) addInflight(request.url);
  if (request.kind === "Image") addImageInflight(request.url);
  if (request.kind === "Font") {
    addFontInflight(request.url);
    try {
      console.warn(`[ks-fonts] @font-face fetch: ${request.url}`);
    } catch {}
  }
}

function snapshotImageNodes(request: ResourceRequest): number[] {
  if (request.kind !== "Image") return [];
  const dom = state.dom as { pendingImageNodes?: (url: string) => ArrayLike<number> } | null;
  if (!dom?.pendingImageNodes) return [];
  try {
    return Array.from(dom.pendingImageNodes(request.url));
  } catch {
    return [];
  }
}

function notifyResourceImages(nodeIds: number[], ok: boolean): void {
  if (nodeIds.length === 0) return;
  try {
    state.notifyImageResults(nodeIds, ok);
  } catch {}
}

function notifyStylesheetError(request: ResourceRequest): void {
  if (request.kind !== "Stylesheet") return;
  try {
    state.notifyStylesheetResults(request.url, false);
  } catch {}
}

function reportResourceError(request: ResourceRequest): void {
  const dom = state.dom as { deliverResourceError?: (id: number) => void } | null;
  if (!dom?.deliverResourceError) return;
  const imageNodes = snapshotImageNodes(request);
  try {
    dom.deliverResourceError(request.id);
  } catch {}
  notifyResourceImages(imageNodes, false);
  notifyStylesheetError(request);
}

function removeCoalescedFetch(key: string, shared: Promise<FetchResult>): void {
  if (inflightFetches.get(key) === shared) inflightFetches.delete(key);
}

function coalescedResourceFetch(request: ResourceRequest): Promise<FetchResult> {
  // CORS mode stays in the key so callers never share a differently entitled response.
  const key = `${request.corsMode}\n${request.url}`;
  const existing = inflightFetches.get(key);
  if (existing) return existing;
  const shared = doRealFetch(request.url, request.kind, request.corsMode);
  inflightFetches.set(key, shared);
  shared.finally(() => removeCoalescedFetch(key, shared));
  return shared;
}

async function waitForImageReevaluation(request: ResourceRequest): Promise<void> {
  if (request.kind !== "Image") return;
  await NativePromise.resolve();
  reevaluateDeferred(request.url);
}

function warnFailedFontFetch(request: ResourceRequest): void {
  if (request.kind !== "Font") return;
  try {
    console.warn(`[ks-fonts] @font-face fetch FAILED: ${request.url}`);
  } catch {}
}

function warnCompletedFontFetch(request: ResourceRequest, bytes: Uint8Array): void {
  if (request.kind !== "Font") return;
  try {
    console.warn(`[ks-fonts] @font-face fetched ${bytes.length} bytes: ${request.url}`);
  } catch {}
}

function shouldRetainFontCustody(request: ResourceRequest, bytes: Uint8Array): boolean {
  return (
    request.kind === "Font" &&
    bytes.length > 0 &&
    bytes.length <= FONT_CUSTODY_BUDGET &&
    fontLoaderMode() === "lazy" &&
    !fontCustody.has(request.url)
  );
}

function evictOldestFontCustody(): boolean {
  const oldest = fontCustody.keys().next().value;
  if (oldest === undefined) return false;
  fontCustodyBytes -= fontCustody.get(oldest)?.length ?? 0;
  fontCustody.delete(oldest);
  return true;
}

function storeFontCustody(url: string, bytes: Uint8Array): void {
  while (fontCustodyBytes + bytes.length > FONT_CUSTODY_BUDGET && fontCustody.size > 0) {
    if (!evictOldestFontCustody()) break;
  }
  fontCustody.set(url, bytes);
  fontCustodyBytes += bytes.length;
}

function retainFontCustody(request: ResourceRequest, bytes: Uint8Array): void {
  if (!shouldRetainFontCustody(request, bytes)) return;
  storeFontCustody(request.url, bytes);
}

function rememberFontKey(request: ResourceRequest, result: SuccessfulFetchResult): void {
  if (request.kind === "Font" && result.fontKey) {
    fontKeyUrls.set(result.fontKey, request.url);
  }
}

function shouldCacheStylesheet(request: ResourceRequest, result: SuccessfulFetchResult): boolean {
  return (
    request.kind === "Stylesheet" &&
    result.cors === "clean" &&
    result.bytes.length > 0 &&
    !resourceCacheStyles.has(request.url)
  );
}

function rememberResourceMetadata(request: ResourceRequest, result: SuccessfulFetchResult): void {
  rememberFontKey(request, result);
  if (request.kind === "Stylesheet") stylesheetCors.set(request.url, result.cors);
  if (shouldCacheStylesheet(request, result)) cacheStylesheet(request.url, result.bytes);
}

function recordSuccessfulResource(request: ResourceRequest, result: SuccessfulFetchResult): void {
  retainFontCustody(request, result.bytes);
  rememberResourceMetadata(request, result);
}

function deliverOpaqueResource(
  dom: ReadyResourceDom,
  id: number,
  result: SuccessfulFetchResult,
): boolean | null {
  const opaque = result.opaqueImage;
  if (opaque && dom.deliverResourceMeta) {
    return dom.deliverResourceMeta(id, opaque.key, opaque.w, opaque.h);
  }
  return null;
}

function deliverFontResource(
  dom: ReadyResourceDom,
  id: number,
  bytes: Uint8Array,
  result: SuccessfulFetchResult,
): boolean | null {
  if (result.fontKey && dom.deliverFontResource) {
    return dom.deliverFontResource(id, bytes, result.fontKey);
  }
  return null;
}

function invokeResourceDelivery(
  dom: ReadyResourceDom,
  request: ResourceRequest,
  result: SuccessfulFetchResult,
): boolean {
  const opaqueResult = deliverOpaqueResource(dom, request.id, result);
  if (opaqueResult !== null) return opaqueResult;
  const fontResult = deliverFontResource(dom, request.id, result.bytes, result);
  if (fontResult !== null) return fontResult;
  return dom.deliverResource(request.id, result.bytes);
}

function measuredResourceDelivery(
  dom: ReadyResourceDom,
  request: ResourceRequest,
  result: SuccessfulFetchResult,
): boolean {
  noteSyncOp(`deliver:${request.kind}`);
  const deliveryStartedAt = Date.now();
  const ok = invokeResourceDelivery(dom, request, result);
  recordDeliverMs(Date.now() - deliveryStartedAt);
  return ok;
}

function completeResourceDelivery(
  request: ResourceRequest,
  imageNodes: number[],
  ok: boolean,
): void {
  if (request.kind === "Font") warnFontDelivery(request.id, ok, request.url);
  if (!ok) return;
  notifyResourceImages(imageNodes, true);
  markResourceDelivered(getInternalState(), request.kind, request.url);
}

function deliverResourceResult(request: ResourceRequest, result: SuccessfulFetchResult): void {
  const dom = state.dom as ResourceDom | null;
  if (!isReadyResourceDom(dom)) return;
  const imageNodes = snapshotImageNodes(request);
  try {
    const ok = measuredResourceDelivery(dom, request, result);
    completeResourceDelivery(request, imageNodes, ok);
  } catch {
    reportResourceError(request);
  }
}

async function fetchAndDeliverResource(request: ResourceRequest): Promise<void> {
  const shared = coalescedResourceFetch(request);
  await waitForImageReevaluation(request);
  const result = await shared;
  if (!result.ok) {
    warnFailedFontFetch(request);
    reportResourceError(request);
    return;
  }
  warnCompletedFontFetch(request, result.bytes);
  recordSuccessfulResource(request, result);
  deliverResourceResult(request, result);
}

function settleResourceFetch(request: TrackedResourceRequest): void {
  if (request.blocksLoad) removeInflight(request.url);
  if (request.kind === "Font") removeFontInflight(request.url);
  if (request.kind === "Image") removeImageInflight(request.url);
  fetchSlots.poke();
  const settledWaiters = resourceSettleWaiters;
  resourceSettleWaiters = [];
  for (const resolveWaiter of settledWaiters) resolveWaiter();
}

function prepareResourceRequest(request: ResourceRequest): TrackedResourceRequest | null {
  if (shouldParkFont(request.kind)) {
    parkFont(request);
    return null;
  }
  const disposition = resourceDisposition(request.id, request.url, request.kind);
  if (disposition.state === "skip") return null;
  const trackedRequest = { ...request, blocksLoad: disposition.blocksLoad };
  trackResourceStart(trackedRequest);
  return trackedRequest;
}

export async function fetchResource(
  id: number,
  url: string,
  kind: string,
  corsMode: string = "",
): Promise<void> {
  const request = { id, url, kind, corsMode };
  // Other resource kinds must enter the inflight counters before yielding to idle waiters.
  if (kind === "Document") await NativePromise.resolve();
  const trackedRequest = prepareResourceRequest(request);
  if (!trackedRequest) return;
  try {
    await fetchAndDeliverResource(request);
  } catch {
    reportResourceError(request);
  } finally {
    settleResourceFetch(trackedRequest);
  }
}

export function installResourceFetchBridge(): void {
  __setBridgeFetchResource(fetchResource);
}
