// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Replays PageScript scene records into screenshot, screencast, and PDF output.
// The renderer pulls scenes over direct JSRPC. Raster panics are caught so the resource cache
// survives, but the cached Vello renderer is dropped.

import { WorkerEntrypoint, abortIsolate } from "cloudflare:workers";
import {
  initSync,
  SceneRasterizer,
  set_ks_tracing,
  set_ks_trace_parent,
  ks_set_emit_hook,
} from "./wasm-glue.js";
import type {
  FetchAsset,
  FetchFont,
  FetchImage,
  PageRendererRpc,
  RenderFrameOpts,
  RenderFrameReply,
  RenderPdfOpts,
  RenderPdfReply,
  RenderPort,
  RenderStage,
  RendererMemoryStats,
} from "@kitesurf/jsrpc-types/page-renderer";

interface RendererEnv {
  KS_INITIAL_RES?: unknown;
  KS_TAIL_TOKEN?: unknown;
  KS_SPAN_SINK?: {
    emit(records: string[]): Promise<unknown> | unknown;
  };
}

function armRendererTracing(env: RendererEnv, traced: boolean, tp?: string): void {
  __ksEnv = env;
  try {
    set_ks_trace_parent(typeof tp === "string" ? tp : "");
  } catch {}
  try {
    set_ks_tracing(traced);
  } catch {}
  armSpanSink(traced);
}
import wasmModule from "./core_bg.wasm";

import type { IsolateKillMarker } from "@kitesurf/jsrpc-types/shared";

const ISOLATE_KILL_MARKER: IsolateKillMarker = "[ks-kill]";

const coreWasmMemory: { current: WebAssembly.Memory | null } = { current: null };
let coreWasmInitialBytes = 0;
const OrigInstance = WebAssembly.Instance;

function getCoreWasmMemory(): WebAssembly.Memory | null {
  return coreWasmMemory.current;
}

// Track memory through the native constructor only while wasm-bindgen initializes the module.
const trackedInstance = new Proxy(OrigInstance, {
  construct(target, argumentsList) {
    const instance = Reflect.construct(target, argumentsList);
    if (
      instance instanceof OrigInstance &&
      instance.exports &&
      instance.exports.memory instanceof WebAssembly.Memory
    ) {
      coreWasmMemory.current = instance.exports.memory;
    }
    return instance;
  },
});
Object.assign(WebAssembly, { Instance: trackedInstance });

initSync({ module: wasmModule });
Object.assign(WebAssembly, { Instance: OrigInstance });
const initialMemory = getCoreWasmMemory();
coreWasmInitialBytes = initialMemory ? initialMemory.buffer.byteLength : 0;
const rasterizer = new SceneRasterizer();

let retainedKey = "";
let retainedSeq = -1;
let retainedScene: Uint8Array | null = null;
// A scene still changes when an animation runs where the viewport can't show
// it, so a poll that encodes the same image answers unchanged. The scroll
// offset rides in the frame metadata, so a scroll over a blank page is still
// a new frame.
let retainedImage: { bytes: Uint8Array; scrollX: number; scrollY: number } | null = null;

// Fonts and images come keyed by hashes the page reports, so cached ones serve only the document
// that supplied them. Another scope, or a call without one, starts from an empty cache.
let resourceScope: string | null = null;
function enterResourceScope(scope: string | undefined): void {
  if (scope !== undefined && scope === resourceScope) return;
  rasterizer.resetResources();
  retainedKey = "";
  retainedSeq = -1;
  retainedScene = null;
  retainedImage = null;
  resourceScope = scope ?? null;
}

function sameBytes(leftBytes: Uint8Array, rightBytes: Uint8Array): boolean {
  const length = leftBytes.length;
  if (length !== rightBytes.length) return false;
  let i = 0;
  if (leftBytes.byteOffset % 4 === 0 && rightBytes.byteOffset % 4 === 0) {
    const words = length >>> 2;
    const leftWords = new Uint32Array(leftBytes.buffer, leftBytes.byteOffset, words);
    const rightWords = new Uint32Array(rightBytes.buffer, rightBytes.byteOffset, words);
    for (let w = 0; w < words; w++) {
      if (leftWords[w] !== rightWords[w]) return false;
    }
    i = words * 4;
  }
  for (; i < length; i++) {
    if (leftBytes[i] !== rightBytes[i]) return false;
  }
  return true;
}

function asU8(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pendingImageKeys(): string[] {
  try {
    return rasterizer.pendingImages();
  } catch {
    return [];
  }
}

function pendingFontAssetPaths(): string[] {
  try {
    const pending: Array<{ path: string }> = JSON.parse(rasterizer.pendingFontAssets());
    return pending.map((fontAsset) => fontAsset.path);
  } catch {
    return [];
  }
}

const MISSING_RESOURCE_HEADER_BYTES = 4;
const MISSING_RESOURCE_ENTRY_BYTES = 9;
const MISSING_RESOURCE_KIND_BYTES = 1;
const MISSING_RESOURCE_HEADER_LITTLE_ENDIAN = true;
const IMAGE_RESOURCE_KIND = 2;
const FONT_DATA_RESOURCE_KIND = 3;
const MAX_RESOURCE_PULL_ROUNDS = 2;
const DEFAULT_RASTER_FORMAT = "png";
const DEFAULT_RASTER_QUALITY = 80;
const MAX_FONT_ASSET_LOG_PATH_CHARS = 48;
const DEFAULT_PDF_PAPER_WIDTH_CSS_PX = 816;
const DEFAULT_PDF_PAPER_HEIGHT_CSS_PX = 1056;
const DEFAULT_PDF_MARGIN_CSS_PX = 0;

function splitMissing(missing: Uint8Array): {
  imageHashes: Uint8Array;
  fontDataHashes: Uint8Array;
  count: number;
} {
  const view = new DataView(missing.buffer, missing.byteOffset, missing.byteLength);
  if (missing.byteLength < MISSING_RESOURCE_HEADER_BYTES) {
    return {
      imageHashes: new Uint8Array(0),
      fontDataHashes: new Uint8Array(0),
      count: 0,
    };
  }
  const count = view.getUint32(0, MISSING_RESOURCE_HEADER_LITTLE_ENDIAN);
  const images: number[] = [];
  const fonts: number[] = [];
  let offset = MISSING_RESOURCE_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    if (offset + MISSING_RESOURCE_ENTRY_BYTES > missing.byteLength) break;
    const kind = view.getUint8(offset);
    const hashBytes = missing.subarray(
      offset + MISSING_RESOURCE_KIND_BYTES,
      offset + MISSING_RESOURCE_ENTRY_BYTES,
    );
    if (kind === IMAGE_RESOURCE_KIND) images.push(...hashBytes);
    else if (kind === FONT_DATA_RESOURCE_KIND) fonts.push(...hashBytes);
    offset += MISSING_RESOURCE_ENTRY_BYTES;
  }
  return {
    imageHashes: new Uint8Array(images),
    fontDataHashes: new Uint8Array(fonts),
    count,
  };
}

function concatMissing(lists: Uint8Array[]): Uint8Array {
  if (lists.length === 1) return lists[0];
  const listsWithHeaders = lists.filter(
    (missingList) => missingList.byteLength >= MISSING_RESOURCE_HEADER_BYTES,
  );
  let count = 0;
  let totalByteLength = MISSING_RESOURCE_HEADER_BYTES;
  for (const missingList of listsWithHeaders) {
    count += new DataView(
      missingList.buffer,
      missingList.byteOffset,
      MISSING_RESOURCE_HEADER_BYTES,
    ).getUint32(0, MISSING_RESOURCE_HEADER_LITTLE_ENDIAN);
    totalByteLength += missingList.byteLength - MISSING_RESOURCE_HEADER_BYTES;
  }
  const output = new Uint8Array(totalByteLength);
  new DataView(output.buffer).setUint32(0, count, MISSING_RESOURCE_HEADER_LITTLE_ENDIAN);
  let offset = MISSING_RESOURCE_HEADER_BYTES;
  for (const missingList of listsWithHeaders) {
    output.set(missingList.subarray(MISSING_RESOURCE_HEADER_BYTES), offset);
    offset += missingList.byteLength - MISSING_RESOURCE_HEADER_BYTES;
  }
  return output;
}

type Timed = <T>(label: string, operation: Promise<T> | T) => Promise<T>;

function makePhaseTimer(phases: string[]): Timed {
  return async (label, operation) => {
    const started = Date.now();
    try {
      return await operation;
    } finally {
      phases.push(`${label}=${Date.now() - started}ms`);
    }
  };
}

function storeFetchedImage(key: string, bytes: Uint8Array | null | undefined): void {
  if (bytes && bytes.length > 0) {
    rasterizer.putImageBytes(key, bytes);
    return;
  }
  try {
    rasterizer.abandonImage(key);
  } catch {}
}

async function fetchFontAsset(
  path: string,
  port: RenderPort,
  fetchAsset: FetchAsset,
  fetchFont: FetchFont | undefined,
  timed: Timed,
): Promise<Uint8Array | null> {
  if (path.startsWith("/")) {
    try {
      return asU8(await timed(`asset(${path})`, fetchAsset(path)));
    } catch {
      return null;
    }
  }

  if (fetchFont && /^[0-9]+$/.test(path)) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = asU8(await timed(`fontKey(${path})`, fetchFont(path)));
    } catch {
      bytes = null;
    }
    if (!bytes || bytes.length === 0) {
      try {
        const reply = await timed(`fontKeyFallback(${path})`, port.getFontUrlData({ key: path }));
        bytes = asU8(reply?.bytes);
      } catch {
        bytes = null;
      }
      console.warn(
        `[ks-rvr] font key ${path} dry in engine store; page fallback ${bytes && bytes.length > 0 ? "ok" : "failed"}`,
      );
    }
    return bytes;
  }

  try {
    const reply = await timed(
      `fontUrl(${path.slice(0, MAX_FONT_ASSET_LOG_PATH_CHARS)})`,
      port.getFontUrlData({ url: path }),
    );
    return asU8(reply?.bytes);
  } catch {
    return null;
  }
}

async function resolveResources(
  missingOf: () => Uint8Array,
  port: RenderPort,
  fetchAsset: FetchAsset,
  fetchImage: FetchImage | undefined,
  fetchFont: FetchFont | undefined,
  timed: Timed,
): Promise<{ error: string; stage: RenderStage } | null> {
  for (let round = 0; round <= MAX_RESOURCE_PULL_ROUNDS; round++) {
    const missing = missingOf();
    const { imageHashes, fontDataHashes, count } = splitMissing(missing);
    if (count === 0) return null;
    if (round === MAX_RESOURCE_PULL_ROUNDS) {
      console.warn(
        `[ks-rvr] unresolvable after ${MAX_RESOURCE_PULL_ROUNDS} rounds: images=[${imageHashes.join(",")}] fonts=[${fontDataHashes.join(",")}]`,
      );
      return {
        error: `unresolvable missing resources after ${MAX_RESOURCE_PULL_ROUNDS} rounds`,
        stage: "resources",
      };
    }
    let batchReply: Awaited<ReturnType<RenderPort["getPaintResources"]>>;
    try {
      batchReply = await timed(
        `resources${round}`,
        port.getPaintResources({ imageHashes, fontDataHashes }),
      );
    } catch (error) {
      return {
        error: `getPaintResources rejected: ${errMsg(error)}`,
        stage: "resources",
      };
    }
    const batch = asU8(batchReply?.batch);
    if (!batch) {
      return {
        error: batchReply?.error || "getPaintResources returned no batch",
        stage: "resources",
      };
    }
    rasterizer.putResources(batch);
    if (fetchImage) {
      const keys = pendingImageKeys();
      const pulls = keys.map((key) =>
        Promise.resolve()
          .then(() => timed(`image(${key})`, fetchImage(key)))
          .then(
            (value) => asU8(value),
            () => null,
          ),
      );
      // Fetch independently, but enter Wasm one image at a time; the rasterizer is not reentrant.
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i] ?? "";
        const bytes = await pulls[i];
        storeFetchedImage(key, bytes);
      }
    }
    for (const path of pendingFontAssetPaths()) {
      const bytes = await fetchFontAsset(path, port, fetchAsset, fetchFont, timed);
      if (bytes && bytes.length > 0) {
        rasterizer.putFontAsset(path, bytes);
      }
    }
  }
  return null;
}

let __ksEnv: RendererEnv | null = null;
let __ksSpanBuf: string[] = [];
let __ksSpanHookArmed = false;
let __ksSpanTotal = 0;
let __ksSpanCapped = false;
const __KS_SPAN_BUDGET = 5000;

function armSpanSink(traced: boolean): void {
  const sink = __ksEnv?.KS_SPAN_SINK;
  if (!traced || !sink) {
    if (__ksSpanHookArmed) {
      try {
        ks_set_emit_hook(null);
      } catch {}
      __ksSpanHookArmed = false;
    }
    return;
  }
  __ksSpanTotal = 0;
  __ksSpanCapped = false;
  __ksSpanBuf = [];
  if (__ksSpanHookArmed) return;
  __ksSpanHookArmed = true;
  try {
    ks_set_emit_hook((spanRecord: string) => {
      if (__ksSpanTotal >= __KS_SPAN_BUDGET) {
        if (!__ksSpanCapped) {
          __ksSpanCapped = true;
          __ksSpanBuf.push(
            `{"name":"child.spans.capped","attributes":[{"key":"budget","value":{"intValue":"${__KS_SPAN_BUDGET}"}}]}`,
          );
        }
        return;
      }
      __ksSpanTotal++;
      __ksSpanBuf.push(spanRecord);
    });
  } catch {
    __ksSpanHookArmed = false;
  }
}

async function flushSpanBatch(): Promise<void> {
  const sink = __ksEnv?.KS_SPAN_SINK;
  if (!sink || __ksSpanBuf.length === 0) return;
  const batch = __ksSpanBuf;
  __ksSpanBuf = [];
  try {
    await sink.emit(batch);
  } catch {}
}

let reservedFromEnv = false;

export class PageRenderer extends WorkerEntrypoint<RendererEnv> implements PageRendererRpc {
  constructor(ctx: ExecutionContext, env: RendererEnv) {
    super(ctx, env);
    // Preallocate the initial viewport to avoid first-frame Wasm heap growth.
    if (!reservedFromEnv) {
      reservedFromEnv = true;
      const raw = env?.KS_INITIAL_RES;
      const dimensions = typeof raw === "string" ? /^(\d+)x(\d+)$/.exec(raw) : null;
      if (dimensions) {
        try {
          rasterizer.reserveFrame(Number(dimensions[1]), Number(dimensions[2]));
        } catch {}
      }
    }
  }

  ping(): { pong: number } {
    return { pong: Date.now() };
  }

  memoryStats(): RendererMemoryStats {
    const memory = getCoreWasmMemory();
    const bytes = memory ? memory.buffer.byteLength : 0;
    return {
      bytes,
      initialBytes: coreWasmInitialBytes,
      deltaBytes: Math.max(0, bytes - coreWasmInitialBytes),
    };
  }

  async renderFrame(
    port: RenderPort,
    opts: RenderFrameOpts,
    fetchAsset: FetchAsset,
    fetchImage?: FetchImage,
    fetchFont?: FetchFont,
  ): Promise<RenderFrameReply> {
    armRendererTracing(this.env, opts.traced === true, opts.tp);
    try {
      const reply = await this.renderFrameImpl(port, opts, fetchAsset, fetchImage, fetchFont);
      return { ...reply, memory: this.memoryStats() };
    } finally {
      await flushSpanBatch();
    }
  }

  private async renderFrameImpl(
    port: RenderPort,
    opts: RenderFrameOpts,
    fetchAsset: FetchAsset,
    fetchImage?: FetchImage,
    fetchFont?: FetchFont,
  ): Promise<RenderFrameReply> {
    const phases: string[] = [];
    const timed = makePhaseTimer(phases);
    enterResourceScope(opts.scope);
    const partialKey =
      typeof opts.partialKey === "string" &&
      opts.partialKey.length > 0 &&
      !opts.clip &&
      opts.omitBackground !== true
        ? opts.partialKey
        : "";
    // Request partial scenes only while JavaScript and Wasm agree on the retained base key.
    const baseValid =
      partialKey !== "" &&
      retainedKey === partialKey &&
      retainedSeq >= 0 &&
      rasterizer.retainedFrameKey() === partialKey;
    let recordReply: Awaited<ReturnType<RenderPort["recordScene"]>>;
    try {
      recordReply = await timed(
        "record",
        port.recordScene({
          omitBackground: opts.omitBackground === true,
          images: opts.images === "encoded" ? "encoded" : "raw",
          ...(typeof opts.sinceSeq === "number" ? { sinceSeq: opts.sinceSeq } : {}),
          ...(opts.clip ? { clip: opts.clip } : {}),
          ...(baseValid
            ? { allowPartial: true, allowScrollShift: true, baseSeq: retainedSeq }
            : {}),
        }),
      );
    } catch (error) {
      return {
        error: `recordScene rejected: ${errMsg(error)}`,
        stage: "record",
        phases,
        seq: 0,
        scrollX: 0,
        scrollY: 0,
      };
    }
    const seq = typeof recordReply?.seq === "number" ? recordReply.seq : 0;
    const scrollX = typeof recordReply?.scrollX === "number" ? recordReply.scrollX : 0;
    const scrollY = typeof recordReply?.scrollY === "number" ? recordReply.scrollY : 0;
    if (recordReply?.unchanged === true) {
      return { unchanged: true, seq, scrollX, scrollY };
    }
    const scene = asU8(recordReply?.scene);
    if (!scene || scene.length === 0) {
      return {
        error: recordReply?.error || "recordScene returned empty scene",
        stage: "record",
        phases,
        seq,
        scrollX,
        scrollY,
      };
    }
    // Only a polling caller whose client holds the retained frame may be told
    // "unchanged". A negative sequence forces a fresh frame.
    const pollsRetained = baseValid && typeof opts.sinceSeq === "number" && opts.sinceSeq >= 0;
    if (
      pollsRetained &&
      recordReply?.partial !== true &&
      retainedScene !== null &&
      sameBytes(retainedScene, scene)
    ) {
      phases.push("sameScene");
      retainedSeq = seq;
      return { unchanged: true, seq, scrollX, scrollY };
    }
    const patches = recordReply?.patches ?? [];
    const scenes = [scene, ...patches.map((patch) => asU8(patch.scene) ?? new Uint8Array(0))];
    const unresolved = await resolveResources(
      () => concatMissing(scenes.map((sceneBytes) => rasterizer.missingResources(sceneBytes))),
      port,
      fetchAsset,
      fetchImage,
      fetchFont,
      timed,
    );
    if (unresolved) {
      return { ...unresolved, phases, seq, scrollX, scrollY };
    }
    const format = typeof opts.format === "string" ? opts.format : DEFAULT_RASTER_FORMAT;
    const quality = typeof opts.quality === "number" ? opts.quality | 0 : DEFAULT_RASTER_QUALITY;
    const clip = recordReply?.clip;
    const isPartial = baseValid && recordReply?.partial === true && !!clip;
    let bytes: Uint8Array | null = null;
    const rasterStart = Date.now();
    try {
      const toViewportPoint = (rect: { x: number; y: number }) => [
        Math.round((Number(rect.x) || 0) - scrollX),
        Math.round((Number(rect.y) || 0) - scrollY),
      ];
      if (isPartial && clip && recordReply?.shift) {
        const ok =
          rasterizer.shiftRetained(partialKey, recordReply.shift.x | 0, recordReply.shift.y | 0) &&
          [{ clip, scene }, ...patches].every((patch) => {
            const [x, y] = toViewportPoint(patch.clip);
            return rasterizer.blitPartial(asU8(patch.scene) ?? new Uint8Array(0), x, y, partialKey);
          });
        bytes = ok ? rasterizer.encodeRetained(format, quality, partialKey) : null;
      } else if (isPartial && clip) {
        const [x, y] = toViewportPoint(clip);
        bytes = rasterizer.rasterizePartial(scene, x, y, format, quality, partialKey);
      } else if (partialKey !== "") {
        bytes = rasterizer.rasterizeAndRetain(
          scene,
          format,
          quality,
          opts.omitBackground === true,
          partialKey,
        );
      } else {
        bytes = rasterizer.rasterize(scene, format, quality, opts.omitBackground === true);
      }
    } catch {
      bytes = null;
    } finally {
      phases.push(`${isPartial ? "rasterPartial" : "raster"}=${Date.now() - rasterStart}ms`);
    }
    const info = rasterizer.lastRasterizeInfo();
    if (!bytes || bytes.length === 0) {
      if (partialKey !== "") {
        retainedKey = "";
        retainedSeq = -1;
        retainedScene = null;
        retainedImage = null;
      }
      return {
        error: `rasterize failed: ${info}`,
        stage: "raster",
        info,
        phases,
        seq,
        scrollX,
        scrollY,
      };
    }
    if (partialKey !== "") {
      const held = rasterizer.retainedFrameKey() === partialKey;
      retainedKey = held ? partialKey : "";
      retainedSeq = held ? seq : -1;
      retainedScene = held && !isPartial ? scene : null;
      const previous = retainedImage;
      retainedImage = held ? { bytes, scrollX, scrollY } : null;
      if (
        held &&
        pollsRetained &&
        previous &&
        previous.scrollX === scrollX &&
        previous.scrollY === scrollY &&
        sameBytes(previous.bytes, bytes)
      ) {
        phases.push("sameImage");
        return { unchanged: true, phases, seq, scrollX, scrollY };
      }
    }
    return { bytes, info, phases, seq, scrollX, scrollY };
  }

  async renderPdf(
    port: RenderPort,
    opts: RenderPdfOpts,
    fetchAsset: FetchAsset,
    fetchImage?: FetchImage,
    fetchFont?: FetchFont,
  ): Promise<RenderPdfReply> {
    armRendererTracing(this.env, opts.traced === true, opts.tp);
    try {
      const reply = await this.renderPdfImpl(port, opts, fetchAsset, fetchImage, fetchFont);
      return { ...reply, memory: this.memoryStats() };
    } finally {
      await flushSpanBatch();
    }
  }

  private async renderPdfImpl(
    port: RenderPort,
    opts: RenderPdfOpts,
    fetchAsset: FetchAsset,
    fetchImage?: FetchImage,
    fetchFont?: FetchFont,
  ): Promise<RenderPdfReply> {
    const phases: string[] = [];
    const timed = makePhaseTimer(phases);
    enterResourceScope(opts.scope);
    const pdfPx = (value: unknown, fallback: number) =>
      typeof value === "number" && Number.isFinite(value) ? Math.max(0, value | 0) : fallback;
    const paperWidth = pdfPx(opts.paperWidth, DEFAULT_PDF_PAPER_WIDTH_CSS_PX);
    const paperHeight = pdfPx(opts.paperHeight, DEFAULT_PDF_PAPER_HEIGHT_CSS_PX);
    const margins = {
      marginTop: pdfPx(opts.marginTop, DEFAULT_PDF_MARGIN_CSS_PX),
      marginRight: pdfPx(opts.marginRight, DEFAULT_PDF_MARGIN_CSS_PX),
      marginBottom: pdfPx(opts.marginBottom, DEFAULT_PDF_MARGIN_CSS_PX),
      marginLeft: pdfPx(opts.marginLeft, DEFAULT_PDF_MARGIN_CSS_PX),
    };
    let recordReply: Awaited<ReturnType<RenderPort["recordPdfScenes"]>>;
    try {
      recordReply = await timed(
        "record",
        port.recordPdfScenes({
          width: paperWidth,
          height: paperHeight,
          ...margins,
        }),
      );
    } catch (error) {
      return {
        error: `recordPdfScenes rejected: ${errMsg(error)}`,
        stage: "record",
        phases,
      };
    }
    const envelope = asU8(recordReply?.envelope);
    if (!envelope || envelope.length === 0) {
      return {
        error: recordReply?.error || "recordPdfScenes returned empty envelope",
        stage: "record",
        phases,
      };
    }
    const unresolved = await resolveResources(
      () => rasterizer.missingResourcesPdf(envelope),
      port,
      fetchAsset,
      fetchImage,
      fetchFont,
      timed,
    );
    if (unresolved) {
      return { ...unresolved, phases };
    }
    let bytes: Uint8Array | null = null;
    const pdfStart = Date.now();
    try {
      bytes = rasterizer.renderPdf(
        envelope,
        paperWidth,
        paperHeight,
        opts.omitBackground === true,
        margins.marginTop,
        margins.marginRight,
        margins.marginBottom,
        margins.marginLeft,
      );
    } catch {
      bytes = null;
    } finally {
      phases.push(`pdf=${Date.now() - pdfStart}ms`);
    }
    const info = rasterizer.lastRasterizeInfo();
    if (!bytes || bytes.length === 0) {
      return {
        error: `renderPdf failed: ${info}`,
        stage: "raster",
        info,
        phases,
      };
    }
    return { bytes, info, phases };
  }

  killIsolate(reason?: string): void {
    const token = this.env.KS_TAIL_TOKEN;
    if (typeof token === "string" && token) {
      console.log(`${ISOLATE_KILL_MARKER} ${token} ${reason || "renderer retired"}`);
    }
    abortIsolate(new Error("PageRenderer.killIsolate"));
  }
}

export default {
  fetch(): Response {
    return new Response("PageRenderer: use the PageRenderer entrypoint", {
      status: 400,
    });
  },
};
