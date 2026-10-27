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
import type { DomHandle } from "./types.ts";

const POOLED_SCENE_MIN_BYTES = 256 * 1024;
const POOLED_SCENE_SLACK_BYTES = 64 * 1024;
const pooledScenes: (ArrayBuffer | null)[] = [null, null];
let pooledSceneTurn = 0;

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
  let buffer = pooledScenes[turn];
  if (!buffer || buffer.byteLength < len || buffer.byteLength > len + POOLED_SCENE_SLACK_BYTES) {
    buffer = new ArrayBuffer(len + POOLED_SCENE_SLACK_BYTES / 2);
    pooledScenes[turn] = buffer;
  }
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

export function ensurePaintDom(): DomHandle | null {
  const dom = state.dom;
  if (!dom) return null;
  if (fontsDeferredUnregistered() && !demandDeferredFonts()) return null;
  demandFacesForScriptText(dom);
  const seq = cascadeSeq();
  if (
    state.paintCacheHandle !== null &&
    state.paintCacheSeq === seq &&
    state.paintCacheViewportW === state.paintViewportW &&
    state.paintCacheViewportH === state.paintViewportH
  ) {
    state.paintCacheFresh = true;
    return state.paintCacheHandle;
  }
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
  state.paintCacheHandle = dom;
  state.paintCacheSeq = seq;
  state.paintCacheViewportW = state.paintViewportW;
  state.paintCacheViewportH = state.paintViewportH;
  state.paintCacheFresh = true;
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

export function rectWithScrollOffset<R extends { x: number; y: number }>(rect: R | null): R | null {
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
      const info = paint.nodeScrollInfo(id);
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
  const maxY = Math.max(0, size.height - state.paintViewportH);
  const maxX = Math.max(0, size.width - state.paintViewportW);
  let nextX = Math.max(0, Math.min(maxX, Math.floor(Number(x) || 0)));
  let nextY = Math.max(0, Math.min(maxY, Math.floor(Number(y) || 0)));
  if (cellW > 0) nextX = state.scrollX + Math.trunc((nextX - state.scrollX) / cellW) * cellW;
  if (cellH > 0) nextY = state.scrollY + Math.trunc((nextY - state.scrollY) / cellH) * cellH;
  if (nextX !== state.scrollX || nextY !== state.scrollY) {
    state.scrollX = nextX;
    state.scrollY = nextY;
    try {
      const paint = ensurePaintDom();
      if (paint && typeof paint.setPageScroll === "function") {
        paint.setPageScroll(nextX, nextY);
      }
    } catch {
      invalidatePaintDom();
    }
    try {
      const internalState = getInternalState();
      internalState.mutationSeq = (internalState.mutationSeq | 0) + 1;
      internalState.paintNeutralSeq = (internalState.paintNeutralSeq | 0) + 1;
    } catch {}
  }
  return { x: state.scrollX, y: state.scrollY };
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

export function computedStyleForAuthId(
  authId: number,
  pseudo?: string,
): Array<{ name: string; value: string; computed?: string; unresolved?: string }> | null {
  if (typeof authId !== "number" || authId < 0) return null;
  const key = `${authId}|${pseudo ?? ""}`;
  const seq = cascadeSeq();
  if (seq !== computedStyleCacheSeq) {
    computedStyleCacheSeq = seq;
    computedStyleCache.clear();
  }
  const cached = computedStyleCache.get(key);
  if (cached !== undefined) {
    computedStyleCache.delete(key);
    computedStyleCache.set(key, cached);
    return cached;
  }
  const paint = ensurePaintDom();
  if (!paint) return null;
  try {
    const raw =
      pseudo && typeof paint.computedStylePseudo === "function"
        ? paint.computedStylePseudo(authId, pseudo)
        : paint.computedStyle(authId);
    if (!Array.isArray(raw)) return null;
    const props = raw.filter((p: { name?: string }) => p && p.name !== "page-orientation");
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
    return props;
  } catch {
    invalidatePaintDom();
    return null;
  }
}

export function computedStyleValueForAuthId(authId: number, name: string): string | null {
  if (typeof authId !== "number" || authId < 0 || name === "page-orientation") return null;
  // The bulk list holds no custom property, so a cached one cannot answer `--name`.
  if (cascadeSeq() === computedStyleCacheSeq && !name.startsWith("--")) {
    const cached = computedStyleCache.get(`${authId}|`);
    if (cached !== undefined) {
      for (const p of cached) if (p.name === name) return p.value;
      return null;
    }
  }
  const paint = ensurePaintDom() as
    | (DomHandle & {
        computedStyleValue?: (id: number, name: string) => string | undefined;
      })
    | null;
  if (!paint || typeof paint.computedStyleValue !== "function") return null;
  try {
    return paint.computedStyleValue(authId, name) ?? null;
  } catch {
    invalidatePaintDom();
    return null;
  }
}
