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
import { __setBridgeFetchResource, DomHandle } from "./wasm-glue.js";
import {
  CLASS_IMAGE_VIEWPORT,
  FetchSlots,
  allHintsLazy,
  classForImageHints,
  classForKind,
} from "./fetch-slots.ts";
import { NativePromise } from "./native-scheduling.ts";
import { runPageTaskWhenUnpaused } from "./page-tasks.ts";
import { getInternalState } from "./internal-state.js";
import { cascadeSeq, invalidatePaintDom } from "./paint.ts";
import { noteSyncOp } from "./lag-monitor.ts";
import {
  responseHeaderGet,
  responseArrayBuffer,
  responseOk,
  mapDelete,
  mapGet,
  mapSet,
  nativeApply,
  NativeUint8Array,
} from "./native-http.ts";
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
  if (url.startsWith("data:")) {
    const DATA_URL_PREFIX_LENGTH = 5;
    const DATA_URL_PERCENT_SIGN_CODE_POINT = 0x25;
    const DATA_URL_PLUS_SIGN_CODE_POINT = 0x2b;
    const DATA_URL_SPACE_CODE_POINT = 0x20;
    const DATA_URL_HEX_RADIX = 16;
    const DATA_URL_BYTE_MASK = 0xff;
    try {
      const comma = url.indexOf(",");
      if (comma < 0) return null;
      const meta = url.slice(DATA_URL_PREFIX_LENGTH, comma);
      const payload = url.slice(comma + 1);
      if (/;base64/i.test(meta)) {
        const bin = atob(payload.replace(/\s+/g, ""));
        return Uint8Array.from(bin, (c) => c.charCodeAt(0));
      }
      const out: number[] = [];
      for (let i = 0; i < payload.length; i++) {
        const characterCode = payload.charCodeAt(i);
        const hexPair =
          characterCode === DATA_URL_PERCENT_SIGN_CODE_POINT && i + 2 < payload.length
            ? payload.slice(i + 1, i + 3)
            : null;
        if (hexPair !== null && /^[0-9a-fA-F]{2}$/.test(hexPair)) {
          out.push(parseInt(hexPair, DATA_URL_HEX_RADIX));
          i += 2;
          continue;
        }
        out.push(
          characterCode === DATA_URL_PLUS_SIGN_CODE_POINT
            ? DATA_URL_SPACE_CODE_POINT
            : characterCode & DATA_URL_BYTE_MASK,
        );
      }
      return Uint8Array.from(out);
    } catch {
      return null;
    }
  }
  const fetchResult = await doRealFetch(url, "Font");
  return fetchResult.ok ? fetchResult.bytes : null;
}

export const resourceCacheStyles = new Map<string, string>();

export const stylesheetCors = new Map<string, "clean" | "opaque">();

export function externalSheetRulesForNode(
  nodeId: number,
): { state: "clean"; text: string } | { state: "denied" } | { state: "pending" } {
  const dom = state.dom as {
    nodeInfo?: (id: number) => { attributes?: unknown[] } | null;
    baseURL?: () => string;
  } | null;
  if (!dom?.nodeInfo) return { state: "pending" };

  let href = "";
  try {
    const attrs = dom.nodeInfo(nodeId)?.attributes;
    if (Array.isArray(attrs)) {
      for (
        let i = 0;
        i + NODE_ATTRIBUTE_VALUE_OFFSET < attrs.length;
        i += NODE_ATTRIBUTE_PAIR_WIDTH
      ) {
        if (String(attrs[i] ?? "").toLowerCase() === "href") {
          href = String(attrs[i + NODE_ATTRIBUTE_VALUE_OFFSET] ?? "");
          break;
        }
      }
    }
  } catch {
    return { state: "pending" };
  }
  if (!href) return { state: "pending" };

  let resolved = "";
  try {
    const base = (dom.baseURL && dom.baseURL()) || "about:blank";
    resolved = new URL(href, base).href;
  } catch {
    return { state: "pending" };
  }

  const verdict = stylesheetCors.get(resolved);
  if (verdict === undefined) return { state: "pending" };
  if (verdict !== "clean") return { state: "denied" };
  const text = resourceCacheStyles.get(resolved);
  if (text === undefined) return { state: "pending" };
  return { state: "clean", text };
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
  const dom = state.dom as {
    pendingImageNodes?: (url: string) => ArrayLike<number>;
    nodeInfo?: (id: number) => { attributes?: unknown[] } | null;
  } | null;
  if (!dom?.pendingImageNodes || !dom.nodeInfo) return null;
  const hints: Array<{ priority: string; lazy: boolean }> = [];
  try {
    for (const id of Array.from(dom.pendingImageNodes(url))) {
      let priority = "";
      let lazy = false;
      const attrs = dom.nodeInfo(id)?.attributes;
      if (!Array.isArray(attrs)) {
        hints.push({ priority, lazy });
        continue;
      }
      for (
        let i = 0;
        i + NODE_ATTRIBUTE_VALUE_OFFSET < attrs.length;
        i += NODE_ATTRIBUTE_PAIR_WIDTH
      ) {
        const name = String(attrs[i] ?? "").toLowerCase();
        if (name === "fetchpriority") {
          priority = String(attrs[i + NODE_ATTRIBUTE_VALUE_OFFSET] ?? "").toLowerCase();
        } else if (name === "loading") {
          lazy = String(attrs[i + NODE_ATTRIBUTE_VALUE_OFFSET] ?? "").toLowerCase() === "lazy";
        }
      }
      hints.push({ priority, lazy });
    }
  } catch {
    return null;
  }
  return hints;
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

function iframeDocumentHint(url: string): { lazy: boolean; crossOrigin: boolean } | null {
  const dom = state.dom as {
    querySelectorAll?: (selector: string) => ArrayLike<number>;
    nodeInfo?: (id: number) => { attributes?: unknown[] } | null;
    baseURL?: () => string;
  } | null;
  if (!dom?.querySelectorAll || !dom.nodeInfo) return null;
  const seq = getInternalState().mutationSeq | 0;
  if (dom === iframeDocumentHintDom && seq === iframeDocumentHintSeq) {
    return iframeDocumentHints.get(url) ?? null;
  }
  const hints = new Map<string, { lazy: boolean; crossOrigin: boolean }>();
  try {
    const base = dom.baseURL?.() || "about:blank";
    const baseOrigin = new URL(base).origin;
    for (const id of Array.from(dom.querySelectorAll("iframe"))) {
      const attrs = dom.nodeInfo(id)?.attributes;
      if (!Array.isArray(attrs)) continue;
      let src = "";
      let lazy = false;
      for (
        let i = 0;
        i + NODE_ATTRIBUTE_VALUE_OFFSET < attrs.length;
        i += NODE_ATTRIBUTE_PAIR_WIDTH
      ) {
        const name = String(attrs[i] ?? "").toLowerCase();
        if (name === "src") {
          src = String(attrs[i + NODE_ATTRIBUTE_VALUE_OFFSET] ?? "");
        }
        if (name === "loading") {
          lazy = String(attrs[i + NODE_ATTRIBUTE_VALUE_OFFSET] ?? "").toLowerCase() === "lazy";
        }
      }
      if (!src) continue;
      let resolved = "";
      try {
        resolved = new URL(src, base).href;
      } catch {
        continue;
      }
      const previous = hints.get(resolved);
      hints.set(resolved, {
        lazy: (previous?.lazy ?? true) && lazy,
        crossOrigin: resolved !== "about:blank" && new URL(resolved).origin !== baseOrigin,
      });
    }
  } catch {
    return null;
  }
  iframeDocumentHintDom = dom;
  iframeDocumentHintSeq = seq;
  iframeDocumentHints = hints;
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

fetchSlots.setBoostProbe((url: string) => {
  if (state.paintCacheHandle === null) return null;
  try {
    const dom = state.dom as { hasPendingCriticalResources?: () => boolean } | null;
    if (dom?.hasPendingCriticalResources?.()) return null;
  } catch {
    return null;
  }
  const cascadeSequence = cascadeSeq() | 0;
  if (cascadeSequence !== boostVerdictSeq) {
    const now = Date.now();
    if (now - boostFlushedAt < BOOST_VERDICT_MAX_AGE_MS) {
      const stale = boostVerdicts.get(url);
      return stale === undefined ? null : stale;
    }
    boostVerdicts.clear();
    boostVerdictSeq = cascadeSequence;
    boostFlushedAt = now;
  }
  const cached = boostVerdicts.get(url);
  if (cached !== undefined) return cached;
  const dom = state.dom as {
    pendingImageNodes?: (url: string) => ArrayLike<number>;
    getBoundingClientRect?: (
      id: number,
    ) => { x?: number; y?: number; width?: number; height?: number } | null;
  } | null;
  if (!dom?.pendingImageNodes || !dom.getBoundingClientRect) return null;
  let verdict: number | null = null;
  try {
    const viewportX = state.scrollX;
    const viewportY = state.scrollY;
    const viewportWidth = state.paintViewportW;
    const viewportHeight = state.paintViewportH;
    for (const id of Array.from(dom.pendingImageNodes(url))) {
      const range = dom.getBoundingClientRect(id);
      if (!range) continue;
      const rangeX = Number(range.x) || 0;
      const rangeY = Number(range.y) || 0;
      const width = Number(range.width) || 0;
      const height = Number(range.height) || 0;
      if (
        rangeX < viewportX + viewportWidth &&
        rangeX + width > viewportX &&
        rangeY < viewportY + viewportHeight &&
        rangeY + height > viewportY
      ) {
        verdict = CLASS_IMAGE_VIEWPORT;
        break;
      }
    }
  } catch {
    invalidatePaintDom();
    verdict = null;
  }
  boostVerdicts.set(url, verdict);
  return verdict;
});

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
type SharedFetch = { done: Promise<void> | null; result: FetchResult | undefined };
const inflightFetches = new Map<string, SharedFetch>();

// Captured before page scripts: the wasm renderer methods receive the private resource bytes.
const nativeDeliverResource = DomHandle.prototype.deliverResource;
const nativeDeliverFontResource = DomHandle.prototype.deliverFontResource;

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
    const headers: Record<string, string> = {
      "x-kitesurf-allow-cross-origin": "1",
    };
    if (kind === "Stylesheet" && corsMode) {
      headers["x-kitesurf-stylesheet-cors"] = corsMode;
    }
    if (state.connectionId) {
      headers["x-kitesurf-connection-id"] = state.connectionId;
    }
    if (state.mainFrameId) {
      headers["x-kitesurf-frame-id"] = state.mainFrameId;
    }
    if (state.cookieKey) {
      headers["x-kitesurf-cookie-key"] = state.cookieKey;
    }
    const response = await trustedFetch(
      url,
      { headers },
      { resourceType: kind || "Other", initiator: "parser" },
    );
    // Release at response headers so body reads do not hold admission capacity.
    release();
    const headersMs = Date.now() - slotStartedAt;
    if (!responseOk(response)) {
      fetchPhaseStats.errors++;
      return { ok: false };
    }
    const cors =
      responseHeaderGet(response, "x-kitesurf-cors") === "clean"
        ? ("clean" as const)
        : ("opaque" as const);
    const bytes = new NativeUint8Array(await responseArrayBuffer(response));
    const slotMs = slotStartedAt - queuedAt;
    const fetchMs = Date.now() - slotStartedAt;
    fetchPhaseStats.count++;
    fetchPhaseStats.slotMs += slotMs;
    fetchPhaseStats.fetchMs += fetchMs;
    fetchPhaseStats.headersMs += headersMs;
    if (slotMs > fetchPhaseStats.maxSlotMs) fetchPhaseStats.maxSlotMs = slotMs;
    if (fetchMs > fetchPhaseStats.maxFetchMs) fetchPhaseStats.maxFetchMs = fetchMs;
    if (fetchMs > SLOW_FETCH_WARNING_MS) {
      console.warn(
        `[ks-fetch] slow fetch: ${fetchMs}ms (headers=${headersMs}ms slot=${slotMs}ms) kind=${kind} url=${url}`,
      );
    }
    return {
      ok: true,
      bytes,
      opaqueImage: readOpaqueImage(response),
      cors,
      fontKey: readFontKey(response),
    };
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
  checkRedirect?: (url: string) => string | null,
  initiator: "script" | "parser" = "script",
): Promise<{
  status: number;
  source: string;
  bytes: Uint8Array;
  contentType: string | null;
  nosniff: string | null;
  opaque: boolean;
  /** The URL after redirects, when the fetch succeeded. */
  finalUrl?: string;
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
      "x-kitesurf-allow-cross-origin": "1",
      "x-kitesurf-script-cors": corsMode,
      accept: "*/*",
      // A classic script without crossorigin sends cookies, as every browser fetch does; the page
      // fetch shim would otherwise default the carrier to same-origin. A CORS script uses
      // same-origin unless its crossorigin attribute asks for use-credentials (case-insensitive).
      ...(crossOrigin == null
        ? { "x-kitesurf-credentials": "include" }
        : {
            "x-kitesurf-credentials":
              crossOrigin.toLowerCase() === "use-credentials" ? "include" : "same-origin",
          }),
    };
    // The engine's opaque bypass requires this marker for no-cors scripts.
    if (corsMode === "no-cors") headers["x-kitesurf-allow-cross-origin"] = "1";
    if (state.connectionId) {
      headers["x-kitesurf-connection-id"] = state.connectionId;
    }
    if (state.mainFrameId) headers["x-kitesurf-frame-id"] = state.mainFrameId;
    if (state.cookieKey) headers["x-kitesurf-cookie-key"] = state.cookieKey;
    const response = await trustedFetch(
      url,
      { headers },
      {
        resourceType: "Script",
        initiator,
        ...(checkRedirect ? { checkRedirect } : {}),
      },
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
      finalUrl: response.url || url,
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

export async function fetchResource(
  id: number,
  url: string,
  kind: string,
  corsMode: string = "",
): Promise<void> {
  if (kind === "Font" && fontDeferActive() && !fontDemandFired()) {
    parkedFonts.push({ id, url, corsMode });
    try {
      console.warn(`[ks-fonts] @font-face parked: ${url}`);
    } catch {}
    return;
  }
  let blocksLoad = true;
  if (kind === "Document") {
    await NativePromise.resolve();
    const hint = iframeDocumentHint(url);
    if (hint === null || hint.crossOrigin) {
      try {
        const dom = state.dom as { deliverResourceError?: (id: number) => void } | null;
        const pending = runPageTaskWhenUnpaused(() => dom?.deliverResourceError?.(id));
        if (pending) await pending;
      } catch {}
      return;
    }
    blocksLoad = !hint.lazy;
  }
  if (blocksLoad) addInflight(url);
  if (kind === "Image") addImageInflight(url);
  if (kind === "Font") {
    addFontInflight(url);
    try {
      console.warn(`[ks-fonts] @font-face fetch: ${url}`);
    } catch {}
  }

  const snapshotImageNodes = (): number[] => {
    if (kind !== "Image") return [];
    const dom = state.dom as { pendingImageNodes?: (url: string) => ArrayLike<number> } | null;
    if (!dom?.pendingImageNodes) return [];
    try {
      return Array.from(dom.pendingImageNodes(url));
    } catch {
      return [];
    }
  };
  const notifyImages = (nodeIds: number[], ok: boolean) => {
    if (nodeIds.length === 0) return;
    try {
      state.notifyImageResults(nodeIds, ok);
    } catch {}
  };

  const reportError = () => {
    const dom = state.dom as { deliverResourceError?: (id: number) => void } | null;
    if (!dom?.deliverResourceError) return;
    const imageNodes = snapshotImageNodes();
    try {
      dom.deliverResourceError(id);
    } catch {}
    notifyImages(imageNodes, false);
    if (kind === "Stylesheet") {
      try {
        state.notifyStylesheetResults(url, false);
      } catch {}
    }
  };

  try {
    // CORS mode stays in the key so callers never share a differently entitled response.
    const coalesceKey = `${corsMode}\n${url}`;
    let shared = mapGet(inflightFetches, coalesceKey);
    if (!shared) {
      // The stored record exposes only a void completion promise; the result stays in this
      // private closure until a waiter has awaited it.
      const entry: SharedFetch = { done: null, result: undefined };
      entry.done = (async () => {
        try {
          entry.result = await doRealFetch(url, kind, corsMode);
        } finally {
          if (mapGet(inflightFetches, coalesceKey) === entry) {
            mapDelete(inflightFetches, coalesceKey);
          }
        }
      })();
      mapSet(inflightFetches, coalesceKey, entry);
      shared = entry;
    }

    if (kind === "Image") {
      await NativePromise.resolve();
      reevaluateDeferred(url);
    }

    if (!shared.done) throw new Error("missing resource completion");
    await shared.done;
    const result = shared.result;
    if (!result) throw new Error("missing resource result");
    if (!result.ok) {
      if (kind === "Font") {
        try {
          console.warn(`[ks-fonts] @font-face fetch FAILED: ${url}`);
        } catch {}
      }
      const pending = runPageTaskWhenUnpaused(reportError);
      if (pending) await pending;
      return;
    }
    const bytes = result.bytes;
    if (kind === "Font") {
      try {
        console.warn(`[ks-fonts] @font-face fetched ${bytes.length} bytes: ${url}`);
      } catch {}
    }

    if (
      kind === "Font" &&
      bytes.length > 0 &&
      bytes.length <= FONT_CUSTODY_BUDGET &&
      fontLoaderMode() === "lazy" &&
      !fontCustody.has(url)
    ) {
      while (fontCustodyBytes + bytes.length > FONT_CUSTODY_BUDGET && fontCustody.size > 0) {
        const oldest = fontCustody.keys().next().value;
        if (oldest === undefined) break;
        fontCustodyBytes -= fontCustody.get(oldest)?.length ?? 0;
        fontCustody.delete(oldest);
      }
      fontCustody.set(url, bytes);
      fontCustodyBytes += bytes.length;
    }

    if (kind === "Font" && result.fontKey) {
      fontKeyUrls.set(result.fontKey, url);
    }

    if (kind === "Stylesheet") {
      stylesheetCors.set(url, result.cors);
    }
    if (
      kind === "Stylesheet" &&
      result.cors === "clean" &&
      bytes.length > 0 &&
      !resourceCacheStyles.has(url)
    ) {
      cacheStylesheet(url, bytes);
    }

    const dom = state.dom as {
      deliverResource?: (id: number, bytes: Uint8Array) => boolean;
      deliverFontResource?: (id: number, bytes: Uint8Array, key: string) => boolean;
      deliverResourceMeta?: (id: number, key: string, w: number, h: number) => boolean;
      deliverResourceError?: (id: number) => void;
    } | null;
    const deliverResource = dom?.deliverResource;
    if (dom && deliverResource) {
      const deliverBytes = (): boolean => {
        const opaque = result.opaqueImage;
        if (opaque && dom.deliverResourceMeta) {
          return dom.deliverResourceMeta(id, opaque.key, opaque.w, opaque.h);
        }
        if (kind === "Font" && result.fontKey && dom.deliverFontResource) {
          return nativeApply(nativeDeliverFontResource, dom, [
            id,
            bytes,
            result.fontKey,
          ]) as boolean;
        }
        return nativeApply(nativeDeliverResource, dom, [id, bytes]) as boolean;
      };
      const pending = runPageTaskWhenUnpaused(() => {
        const imageNodes = snapshotImageNodes();
        try {
          noteSyncOp(`deliver:${kind}`);
          const deliveryStartedAt = Date.now();
          const ok = deliverBytes();
          recordDeliverMs(Date.now() - deliveryStartedAt);
          if (kind === "Font") warnFontDelivery(id, ok, url);
          if (!ok) return;
          notifyImages(imageNodes, true);
          markResourceDelivered(getInternalState(), kind, url);
        } catch {
          reportError();
        }
      });
      if (pending) await pending;
    }
  } catch {
    const pending = runPageTaskWhenUnpaused(reportError);
    if (pending) await pending;
  } finally {
    if (blocksLoad) removeInflight(url);
    if (kind === "Font") removeFontInflight(url);
    if (kind === "Image") removeImageInflight(url);
    fetchSlots.poke();
    const settledWaiters = resourceSettleWaiters;
    resourceSettleWaiters = [];
    for (const resolveWaiter of settledWaiters) resolveWaiter();
  }
}

export function installResourceFetchBridge(): void {
  __setBridgeFetchResource(fetchResource);
}
