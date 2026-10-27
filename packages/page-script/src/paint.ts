// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Prepares the live DOM for geometry reads, scrolling, and scene recording.
// PageScript records scenes but never rasterizes them; PageRenderer pulls and replays them.

import {
  demandDeferredFonts,
  fontsDeferredUnregistered,
  demandFacesForScriptText,
} from "./font-loader.ts";
import { getInternalState } from "./internal-state.js";
import { noteSyncOp } from "./lag-monitor.ts";
import { state } from "./state.ts";
import type { DomHandle, DomRect } from "./types.ts";

interface DomScrollInfo {
  clientWidth: number;
  scrollWidth: number;
  clientHeight: number;
  scrollHeight: number;
}

const POOLED_SCENE_MIN_BYTES = 256 * 1024;
const POOLED_SCENE_SLACK_BYTES = 64 * 1024;
const pooledScenes: (ArrayBuffer | null)[] = [null, null];
let pooledSceneTurn = 0;

function pooledBufferForScene(turn: number, len: number): ArrayBuffer {
  let buffer = pooledScenes[turn];
  if (!buffer || buffer.byteLength < len || buffer.byteLength > len + POOLED_SCENE_SLACK_BYTES) {
    buffer = new ArrayBuffer(len + POOLED_SCENE_SLACK_BYTES / 2);
    pooledScenes[turn] = buffer;
  }
  return buffer;
}

export function renderSceneRawPooled(
  paint: DomHandle,
  memory: WebAssembly.Memory | null,
  ...args: Parameters<DomHandle["renderSceneRaw"]>
): Uint8Array {
  const [scrollX, scrollY, overdrawTop, overdrawBottom, omitBackground, clientWire] = args;
  if (!memory) {
    return paint.renderSceneRaw(
      scrollX,
      scrollY,
      overdrawTop,
      overdrawBottom,
      omitBackground,
      clientWire,
    );
  }
  const len = paint.renderSceneRawStaged(
    scrollX,
    scrollY,
    overdrawTop,
    overdrawBottom,
    omitBackground,
    clientWire,
  );
  const staged = new Uint8Array(memory.buffer, paint.stagedScenePtr(), len);
  if (len < POOLED_SCENE_MIN_BYTES) return staged.slice();
  // Two buffers keep the previous RPC scene intact across one interleaved recording.
  const turn = pooledSceneTurn;
  pooledSceneTurn ^= 1;
  const buffer = pooledBufferForScene(turn, len);
  const scene = new Uint8Array(buffer, 0, len);
  scene.set(staged);
  return scene;
}

let paintPrepCount = 0;

export function paintPrepStats(): { prepares: number } {
  return { prepares: paintPrepCount };
}

export function cascadeSeq(): number {
  const internalState = getInternalState();
  return ((internalState.mutationSeq | 0) - (internalState.paintNeutralSeq | 0)) | 0;
}

function paintCacheMatches(seq: number): boolean {
  return (
    state.paintCacheHandle !== null &&
    state.paintCacheSeq === seq &&
    state.paintCacheViewportW === state.paintViewportW &&
    state.paintCacheViewportH === state.paintViewportH
  );
}

function prepareDomForPaint(dom: DomHandle): void {
  noteSyncOp("prepareForPaint");
  paintPrepCount++;
  try {
    dom.prepareForPaint(state.paintViewportW, state.paintViewportH);
  } catch {}
  try {
    if (state.currentMediaType === "print" && typeof dom.setMediaType === "function") {
      dom.setMediaType("print");
    }
  } catch {}
}

function cachePaintDom(dom: DomHandle, seq: number): void {
  state.paintCacheHandle = dom;
  state.paintCacheSeq = seq;
  state.paintCacheViewportW = state.paintViewportW;
  state.paintCacheViewportH = state.paintViewportH;
  state.paintCacheFresh = true;
}

export function ensurePaintDom(): DomHandle | null {
  const dom = state.dom;
  if (!dom) return null;
  if (fontsDeferredUnregistered() && !demandDeferredFonts()) return null;
  demandFacesForScriptText(dom);
  const seq = cascadeSeq();
  if (paintCacheMatches(seq)) {
    state.paintCacheFresh = true;
    return state.paintCacheHandle;
  }
  prepareDomForPaint(dom);
  cachePaintDom(dom, seq);
  return state.paintCacheHandle;
}

export function takePaintPrep(): { paint: DomHandle | null; fresh: boolean } {
  const paint = ensurePaintDom();
  const fresh = state.paintCacheFresh;
  state.paintCacheFresh = false;
  return { paint, fresh };
}

export function kickLayoutForFontFaceDiscovery(): void {
  try {
    const paint = ensurePaintDom();
    if (!paint) return;
    const id = paint.querySelector("html");
    if (typeof id === "number" && id >= 0) paint.getBoundingClientRect(id);
  } catch {
    invalidatePaintDom();
  }
}

export function invalidatePaintDom(): void {
  state.paintCacheHandle = null;
  state.paintCacheSeq = -1;
  state.paintCacheViewportW = 0;
  state.paintCacheViewportH = 0;
}

export function rectWithScrollOffset(rect: DomRect | null): DomRect | null {
  if (!rect) return rect;
  return {
    ...rect,
    x: (Number(rect.x) || 0) - state.scrollX,
    y: (Number(rect.y) || 0) - state.scrollY,
  };
}

export function documentScrollSize(): { width: number; height: number } {
  const paint = ensurePaintDom();
  if (!paint) return { width: state.paintViewportW, height: state.paintViewportH };
  let maxWidth = state.paintViewportW;
  let maxHeight = state.paintViewportH;
  try {
    const id = paint.querySelector("html");
    if (typeof id === "number" && id >= 0) {
      const info = paint.nodeScrollInfo(id) as DomScrollInfo | null;
      if (info) {
        maxWidth = Math.max(
          maxWidth,
          (Number(info.clientWidth) || 0) + (Number(info.scrollWidth) || 0),
        );
        maxHeight = Math.max(
          maxHeight,
          (Number(info.clientHeight) || 0) + (Number(info.scrollHeight) || 0),
        );
      }
    }
  } catch {
    invalidatePaintDom();
  }
  return {
    width: Math.max(state.paintViewportW, Math.ceil(maxWidth)),
    height: Math.max(state.paintViewportH, Math.ceil(maxHeight)),
  };
}

export function documentScrollHeight(): number {
  return documentScrollSize().height;
}

export function documentScrollWidth(): number {
  return documentScrollSize().width;
}

export function setScrollOffset(
  x: number,
  y: number,
  cellW = 0,
  cellH = 0,
): { x: number; y: number } {
  const size = documentScrollSize();
  const clamped = clampScrollOffset(x, y, size);
  const snapped = snapScrollOffset(clamped.x, clamped.y, cellW, cellH);
  if (snapped.x !== state.scrollX || snapped.y !== state.scrollY) {
    applyScrollOffset(snapped.x, snapped.y);
  }
  return { x: state.scrollX, y: state.scrollY };
}

function clampScrollOffset(
  x: number,
  y: number,
  size: { width: number; height: number },
): { x: number; y: number } {
  const maxY = Math.max(0, size.height - state.paintViewportH);
  const maxX = Math.max(0, size.width - state.paintViewportW);
  let nextX = Math.max(0, Math.min(maxX, Math.floor(Number(x) || 0)));
  let nextY = Math.max(0, Math.min(maxY, Math.floor(Number(y) || 0)));
  return { x: nextX, y: nextY };
}

function snapScrollOffset(
  x: number,
  y: number,
  cellW: number,
  cellH: number,
): { x: number; y: number } {
  let nextX = x;
  let nextY = y;
  if (cellW > 0) nextX = state.scrollX + Math.trunc((nextX - state.scrollX) / cellW) * cellW;
  if (cellH > 0) nextY = state.scrollY + Math.trunc((nextY - state.scrollY) / cellH) * cellH;
  return { x: nextX, y: nextY };
}

function applyScrollOffset(x: number, y: number): void {
  state.scrollX = x;
  state.scrollY = y;
  try {
    const paint = ensurePaintDom();
    if (paint && typeof paint.setPageScroll === "function") paint.setPageScroll(x, y);
  } catch {
    invalidatePaintDom();
  }
  try {
    const internalState = getInternalState();
    internalState.mutationSeq = (internalState.mutationSeq | 0) + 1;
    internalState.paintNeutralSeq = (internalState.paintNeutralSeq | 0) + 1;
  } catch {}
}

export function scrollBy(dx: number, dy: number): { x: number; y: number } {
  return setScrollOffset(state.scrollX + (Number(dx) || 0), state.scrollY + (Number(dy) || 0));
}

const COMPUTED_STYLE_CACHE_MAX_ENTRIES = 64;
const computedStyleCache = new Map<
  string,
  Array<{ name: string; value: string; computed?: string; unresolved?: string }>
>();
let computedStyleCacheSeq = -1;
let computedStyleCacheDropQueued = false;

function isValidAuthId(authId: number): boolean {
  return typeof authId === "number" && authId >= 0;
}

function resetComputedStyleCache(seq: number): void {
  if (seq === computedStyleCacheSeq) return;
  computedStyleCacheSeq = seq;
  computedStyleCache.clear();
}

function touchComputedStyleCache(
  key: string,
): Array<{ name: string; value: string; computed?: string; unresolved?: string }> | undefined {
  const cached = computedStyleCache.get(key);
  if (cached !== undefined) {
    computedStyleCache.delete(key);
    computedStyleCache.set(key, cached);
  }
  return cached;
}

function readComputedStyle(paint: DomHandle, authId: number, pseudo?: string): unknown {
  return pseudo && typeof paint.computedStylePseudo === "function"
    ? paint.computedStylePseudo(authId, pseudo)
    : paint.computedStyle(authId);
}

function computedStyleCacheKey(authId: number, pseudo: string | undefined): string {
  return `${authId}|${pseudo ?? ""}`;
}

type ComputedStyleProperty = {
  name: string;
  value: string;
  computed?: string;
  unresolved?: string;
};

function hasStringField(value: object, name: string): boolean {
  return name in value && typeof Reflect.get(value, name, value) === "string";
}

function hasOptionalStringField(value: object, name: string): boolean {
  return !(name in value) || typeof Reflect.get(value, name, value) === "string";
}

function isNonNullObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function hasComputedStyleFields(value: object): boolean {
  return hasStringField(value, "name") && hasStringField(value, "value");
}

function isVisibleComputedStyleProperty(value: object): boolean {
  if (Reflect.get(value, "name", value) === "page-orientation") return false;
  return hasOptionalStringField(value, "computed") && hasOptionalStringField(value, "unresolved");
}

function isComputedStyleProperty(value: unknown): value is ComputedStyleProperty {
  if (!isNonNullObject(value)) return false;
  if (!hasComputedStyleFields(value)) return false;
  if (!isVisibleComputedStyleProperty(value)) return false;
  return true;
}

function cacheComputedStyle(
  key: string,
  props: Array<{ name: string; value: string; computed?: string; unresolved?: string }>,
): void {
  if (computedStyleCache.size >= COMPUTED_STYLE_CACHE_MAX_ENTRIES) {
    const oldest = computedStyleCache.keys().next().value;
    if (oldest !== undefined) computedStyleCache.delete(oldest);
  }
  computedStyleCache.set(key, props);
  if (!computedStyleCacheDropQueued) {
    computedStyleCacheDropQueued = true;
    queueMicrotask(() => {
      computedStyleCacheDropQueued = false;
      computedStyleCache.clear();
    });
  }
}

function readAndCacheComputedStyle(
  paint: DomHandle,
  authId: number,
  pseudo: string | undefined,
  key: string,
): Array<{ name: string; value: string; computed?: string; unresolved?: string }> | null {
  try {
    const raw = readComputedStyle(paint, authId, pseudo);
    if (!Array.isArray(raw)) return null;
    const props = raw.filter(isComputedStyleProperty);
    cacheComputedStyle(key, props);
    return props;
  } catch {
    invalidatePaintDom();
    return null;
  }
}

export function computedStyleForAuthId(
  authId: number,
  pseudo?: string,
): Array<{ name: string; value: string; computed?: string; unresolved?: string }> | null {
  if (!isValidAuthId(authId)) return null;
  const key = computedStyleCacheKey(authId, pseudo);
  const seq = cascadeSeq();
  resetComputedStyleCache(seq);
  const cached = touchComputedStyleCache(key);
  if (cached !== undefined) {
    return cached;
  }
  const paint = ensurePaintDom();
  if (!paint) return null;
  return readAndCacheComputedStyle(paint, authId, pseudo, key);
}

function isValidComputedStyleValueRequest(authId: number, name: string): boolean {
  return typeof authId === "number" && authId >= 0 && name !== "page-orientation";
}

function cachedComputedStyleValue(authId: number, name: string): string | null | undefined {
  if (cascadeSeq() !== computedStyleCacheSeq) return undefined;
  const cached = computedStyleCache.get(`${authId}|`);
  if (cached === undefined) return undefined;
  for (const property of cached) {
    if (property.name === name) return property.value;
  }
  return null;
}

function canReadComputedStyleValue(
  paint:
    | (DomHandle & { computedStyleValue?: (id: number, name: string) => string | undefined })
    | null,
): paint is DomHandle & { computedStyleValue: (id: number, name: string) => string | undefined } {
  return !!paint && typeof paint.computedStyleValue === "function";
}

function readComputedStyleValue(
  paint: DomHandle & { computedStyleValue: (id: number, name: string) => string | undefined },
  authId: number,
  name: string,
): string | null {
  try {
    return paint.computedStyleValue(authId, name) ?? null;
  } catch {
    invalidatePaintDom();
    return null;
  }
}

export function computedStyleValueForAuthId(authId: number, name: string): string | null {
  if (!isValidComputedStyleValueRequest(authId, name)) return null;
  const cached = cachedComputedStyleValue(authId, name);
  if (cached !== undefined) return cached;
  const paint = ensurePaintDom() as
    | (DomHandle & {
        computedStyleValue?: (id: number, name: string) => string | undefined;
      })
    | null;
  if (!canReadComputedStyleValue(paint)) return null;
  return readComputedStyleValue(paint, authId, name);
}
