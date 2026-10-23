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

function sameAlignedWords(
  leftBytes: Uint8Array,
  rightBytes: Uint8Array,
  wordCount: number,
): boolean {
  const leftWords = new Uint32Array(leftBytes.buffer, leftBytes.byteOffset, wordCount);
  const rightWords = new Uint32Array(rightBytes.buffer, rightBytes.byteOffset, wordCount);
  for (let word = 0; word < wordCount; word++) {
    if (leftWords[word] !== rightWords[word]) return false;
  }
  return true;
}

function sameRemainingBytes(leftBytes: Uint8Array, rightBytes: Uint8Array, start: number): boolean {
  for (let index = start; index < leftBytes.length; index++) {
    if (leftBytes[index] !== rightBytes[index]) return false;
  }
  return true;
}

function sameBytes(leftBytes: Uint8Array, rightBytes: Uint8Array): boolean {
  if (leftBytes.length !== rightBytes.length) return false;
  let start = 0;
  if (leftBytes.byteOffset % 4 === 0 && rightBytes.byteOffset % 4 === 0) {
    const wordCount = leftBytes.length >>> 2;
    if (!sameAlignedWords(leftBytes, rightBytes, wordCount)) return false;
    start = wordCount * 4;
  }
  return sameRemainingBytes(leftBytes, rightBytes, start);
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

interface MissingResourceSplit {
  imageHashes: Uint8Array;
  fontDataHashes: Uint8Array;
  count: number;
}

function emptyMissingSplit(): MissingResourceSplit {
  return {
    imageHashes: new Uint8Array(0),
    fontDataHashes: new Uint8Array(0),
    count: 0,
  };
}

function appendMissingHash(
  kind: number,
  hashBytes: Uint8Array,
  images: number[],
  fonts: number[],
): void {
  if (kind === IMAGE_RESOURCE_KIND) images.push(...hashBytes);
  else if (kind === FONT_DATA_RESOURCE_KIND) fonts.push(...hashBytes);
}

function splitMissingEntries(
  missing: Uint8Array,
  view: DataView,
  count: number,
): MissingResourceSplit {
  const images: number[] = [];
  const fonts: number[] = [];
  let offset = MISSING_RESOURCE_HEADER_BYTES;
  for (let index = 0; index < count; index++) {
    if (offset + MISSING_RESOURCE_ENTRY_BYTES > missing.byteLength) break;
    const kind = view.getUint8(offset);
    const hashBytes = missing.subarray(
      offset + MISSING_RESOURCE_KIND_BYTES,
      offset + MISSING_RESOURCE_ENTRY_BYTES,
    );
    appendMissingHash(kind, hashBytes, images, fonts);
    offset += MISSING_RESOURCE_ENTRY_BYTES;
  }
  return { imageHashes: new Uint8Array(images), fontDataHashes: new Uint8Array(fonts), count };
}

function splitMissing(missing: Uint8Array): MissingResourceSplit {
  const view = new DataView(missing.buffer, missing.byteOffset, missing.byteLength);
  if (missing.byteLength < MISSING_RESOURCE_HEADER_BYTES) return emptyMissingSplit();
  const count = view.getUint32(0, MISSING_RESOURCE_HEADER_LITTLE_ENDIAN);
  return splitMissingEntries(missing, view, count);
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

async function fetchAssetFont(
  path: string,
  fetchAsset: FetchAsset,
  timed: Timed,
): Promise<Uint8Array | null> {
  try {
    return asU8(await timed(`asset(${path})`, fetchAsset(path)));
  } catch {
    return null;
  }
}

async function fetchStoredFont(
  path: string,
  fetchFont: FetchFont,
  timed: Timed,
): Promise<Uint8Array | null> {
  try {
    return asU8(await timed(`fontKey(${path})`, fetchFont(path)));
  } catch {
    return null;
  }
}

async function fetchFontKeyFallback(
  path: string,
  port: RenderPort,
  timed: Timed,
): Promise<Uint8Array | null> {
  try {
    const reply = await timed(`fontKeyFallback(${path})`, port.getFontUrlData({ key: path }));
    return asU8(reply?.bytes);
  } catch {
    return null;
  }
}

function fontReadStatus(bytes: Uint8Array | null): string {
  return bytes && bytes.length > 0 ? "ok" : "failed";
}

async function fetchKeyFont(
  path: string,
  port: RenderPort,
  fetchFont: FetchFont,
  timed: Timed,
): Promise<Uint8Array | null> {
  let bytes = await fetchStoredFont(path, fetchFont, timed);
  if (!bytes || bytes.length === 0) {
    bytes = await fetchFontKeyFallback(path, port, timed);
    console.warn(
      `[ks-rvr] font key ${path} dry in engine store; page fallback ${fontReadStatus(bytes)}`,
    );
  }
  return bytes;
}

async function fetchFontUrl(
  path: string,
  port: RenderPort,
  timed: Timed,
): Promise<Uint8Array | null> {
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

async function fetchFontAsset(
  path: string,
  port: RenderPort,
  fetchAsset: FetchAsset,
  fetchFont: FetchFont | undefined,
  timed: Timed,
): Promise<Uint8Array | null> {
  if (path.startsWith("/")) return fetchAssetFont(path, fetchAsset, timed);
  if (fetchFont && /^[0-9]+$/.test(path)) return fetchKeyFont(path, port, fetchFont, timed);
  return fetchFontUrl(path, port, timed);
}

type ResourceBatch = { batch: Uint8Array } | { error: string };
type ResourceReply = Awaited<ReturnType<RenderPort["getPaintResources"]>>;
type ResourceReplyRequest = { reply: ResourceReply } | { error: string };
type ResourceRoundOutcome =
  | { kind: "resolved" }
  | { kind: "retry" }
  | { kind: "error"; error: string };

async function requestResourceReply(
  round: number,
  imageHashes: Uint8Array,
  fontDataHashes: Uint8Array,
  port: RenderPort,
  timed: Timed,
): Promise<ResourceReplyRequest> {
  try {
    return {
      reply: await timed(
        `resources${round}`,
        port.getPaintResources({ imageHashes, fontDataHashes }),
      ),
    };
  } catch (error) {
    return { error: `getPaintResources rejected: ${errMsg(error)}` };
  }
}

function resourceBatchFromReply(reply: ResourceReply): ResourceBatch {
  const batch = asU8(reply?.batch);
  if (!batch) return { error: reply?.error || "getPaintResources returned no batch" };
  return { batch };
}

async function requestResourceBatch(
  round: number,
  imageHashes: Uint8Array,
  fontDataHashes: Uint8Array,
  port: RenderPort,
  timed: Timed,
): Promise<ResourceBatch> {
  const result = await requestResourceReply(round, imageHashes, fontDataHashes, port, timed);
  if ("error" in result) return result;
  return resourceBatchFromReply(result.reply);
}

async function fetchPendingImages(fetchImage: FetchImage | undefined, timed: Timed): Promise<void> {
  if (!fetchImage) return;
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
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index] ?? "";
    const bytes = await pulls[index];
    storeFetchedImage(key, bytes);
  }
}

async function fetchPendingFonts(
  port: RenderPort,
  fetchAsset: FetchAsset,
  fetchFont: FetchFont | undefined,
  timed: Timed,
): Promise<void> {
  for (const path of pendingFontAssetPaths()) {
    const bytes = await fetchFontAsset(path, port, fetchAsset, fetchFont, timed);
    if (bytes && bytes.length > 0) rasterizer.putFontAsset(path, bytes);
  }
}

function unresolvedResourceError(
  imageHashes: Uint8Array,
  fontDataHashes: Uint8Array,
): ResourceRoundOutcome {
  console.warn(
    `[ks-rvr] unresolvable after ${MAX_RESOURCE_PULL_ROUNDS} rounds: images=[${imageHashes.join(",")}] fonts=[${fontDataHashes.join(",")}]`,
  );
  return {
    kind: "error",
    error: `unresolvable missing resources after ${MAX_RESOURCE_PULL_ROUNDS} rounds`,
  };
}

async function resolveResourceRound(
  round: number,
  missingOf: () => Uint8Array,
  port: RenderPort,
  fetchAsset: FetchAsset,
  fetchImage: FetchImage | undefined,
  fetchFont: FetchFont | undefined,
  timed: Timed,
): Promise<ResourceRoundOutcome> {
  const { imageHashes, fontDataHashes, count } = splitMissing(missingOf());
  if (count === 0) return { kind: "resolved" };
  if (round === MAX_RESOURCE_PULL_ROUNDS) {
    return unresolvedResourceError(imageHashes, fontDataHashes);
  }
  const resources = await requestResourceBatch(round, imageHashes, fontDataHashes, port, timed);
  if ("error" in resources) return { kind: "error", error: resources.error };
  rasterizer.putResources(resources.batch);
  await fetchPendingImages(fetchImage, timed);
  await fetchPendingFonts(port, fetchAsset, fetchFont, timed);
  return { kind: "retry" };
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
    const outcome = await resolveResourceRound(
      round,
      missingOf,
      port,
      fetchAsset,
      fetchImage,
      fetchFont,
      timed,
    );
    if (outcome.kind === "resolved") return null;
    if (outcome.kind === "error") return { error: outcome.error, stage: "resources" };
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
    disarmSpanSink();
    return;
  }
  __ksSpanTotal = 0;
  __ksSpanCapped = false;
  __ksSpanBuf = [];
  if (__ksSpanHookArmed) return;
  __ksSpanHookArmed = true;
  installSpanHook();
}

function disarmSpanSink(): void {
  if (!__ksSpanHookArmed) return;
  try {
    ks_set_emit_hook(null);
  } catch {
    __ksSpanHookArmed = false;
  }
  __ksSpanHookArmed = false;
}

function recordSpan(spanRecord: string): void {
  if (__ksSpanTotal < __KS_SPAN_BUDGET) {
    __ksSpanTotal++;
    __ksSpanBuf.push(spanRecord);
    return;
  }
  if (__ksSpanCapped) return;
  __ksSpanCapped = true;
  __ksSpanBuf.push(
    `{"name":"child.spans.capped","attributes":[{"key":"budget","value":{"intValue":"${__KS_SPAN_BUDGET}"}}]}`,
  );
}

function installSpanHook(): void {
  try {
    ks_set_emit_hook(recordSpan);
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

function reserveInitialFrame(env: RendererEnv): void {
  const raw = env?.KS_INITIAL_RES;
  const dimensions = typeof raw === "string" ? /^(\d+)x(\d+)$/.exec(raw) : null;
  if (!dimensions) return;
  try {
    rasterizer.reserveFrame(Number(dimensions[1]), Number(dimensions[2]));
  } catch {}
}

type FrameRecordReply = Awaited<ReturnType<RenderPort["recordScene"]>>;
type FrameRecordPatch = NonNullable<FrameRecordReply["patches"]>[number];
type FrameClip = NonNullable<FrameRecordReply["clip"]>;
type FrameShift = NonNullable<FrameRecordReply["shift"]>;

interface FramePosition {
  seq: number;
  scrollX: number;
  scrollY: number;
}

interface FrameScene {
  recordReply: FrameRecordReply;
  scene: Uint8Array;
  patches: FrameRecordPatch[];
  seq: number;
  scrollX: number;
  scrollY: number;
}

type FramePreparation =
  | { kind: "reply"; reply: RenderFrameReply }
  | { kind: "scene"; frame: FrameScene };

type FrameRecordRequest = { reply: FrameRecordReply } | { failure: unknown };

function framePartialKey(opts: RenderFrameOpts): string {
  return typeof opts.partialKey === "string" &&
    opts.partialKey.length > 0 &&
    !opts.clip &&
    opts.omitBackground !== true
    ? opts.partialKey
    : "";
}

function retainedBaseIsValid(partialKey: string): boolean {
  return (
    partialKey !== "" &&
    retainedKey === partialKey &&
    retainedSeq >= 0 &&
    rasterizer.retainedFrameKey() === partialKey
  );
}

function frameRecordOptions(
  opts: RenderFrameOpts,
  baseValid: boolean,
): Parameters<RenderPort["recordScene"]>[0] {
  return {
    omitBackground: opts.omitBackground === true,
    images: opts.images === "encoded" ? "encoded" : "raw",
    ...(typeof opts.sinceSeq === "number" ? { sinceSeq: opts.sinceSeq } : {}),
    ...(opts.clip ? { clip: opts.clip } : {}),
    ...(baseValid ? { allowPartial: true, allowScrollShift: true, baseSeq: retainedSeq } : {}),
  };
}

async function requestFrameRecord(
  port: RenderPort,
  opts: RenderFrameOpts,
  baseValid: boolean,
  timed: Timed,
): Promise<FrameRecordRequest> {
  try {
    return {
      reply: await timed("record", port.recordScene(frameRecordOptions(opts, baseValid))),
    };
  } catch (failure) {
    return { failure };
  }
}

function framePosition(recordReply: FrameRecordReply): FramePosition {
  return {
    seq: numberOrZero(recordReply?.seq),
    scrollX: numberOrZero(recordReply?.scrollX),
    scrollY: numberOrZero(recordReply?.scrollY),
  };
}

function numberOrZero(value: number | undefined): number {
  return typeof value === "number" ? value : 0;
}

function failedFrameRecord(failure: unknown, phases: string[]): RenderFrameReply {
  return {
    error: `recordScene rejected: ${errMsg(failure)}`,
    stage: "record",
    phases,
    seq: 0,
    scrollX: 0,
    scrollY: 0,
  };
}

function emptyFrameSceneReply(
  recordReply: FrameRecordReply,
  phases: string[],
  position: FramePosition,
): RenderFrameReply {
  return {
    error: recordReply?.error || "recordScene returned empty scene",
    stage: "record",
    phases,
    ...position,
  };
}

function hasNonnegativeSinceSeq(sinceSeq: number | undefined): boolean {
  return typeof sinceSeq === "number" && sinceSeq >= 0;
}

function canReuseSameScene(
  baseValid: boolean,
  opts: RenderFrameOpts,
  recordReply: FrameRecordReply,
): boolean {
  return (
    baseValid &&
    hasNonnegativeSinceSeq(opts.sinceSeq) &&
    recordReply?.partial !== true &&
    retainedScene !== null
  );
}

function hasRetainedSceneBytes(scene: Uint8Array): boolean {
  return retainedScene !== null && sameBytes(retainedScene, scene);
}

function sameSceneReply(
  scene: Uint8Array,
  recordReply: FrameRecordReply,
  opts: RenderFrameOpts,
  baseValid: boolean,
  phases: string[],
  position: FramePosition,
): RenderFrameReply | null {
  if (!canReuseSameScene(baseValid, opts, recordReply)) return null;
  if (!hasRetainedSceneBytes(scene)) return null;
  phases.push("sameScene");
  retainedSeq = position.seq;
  return { unchanged: true, ...position };
}

function isNonemptyBytes(bytes: Uint8Array | null): bytes is Uint8Array {
  return bytes !== null && bytes.length > 0;
}

function unchangedFrameReply(
  recordReply: FrameRecordReply,
  position: FramePosition,
): RenderFrameReply | null {
  return recordReply?.unchanged === true ? { unchanged: true, ...position } : null;
}

function recordSceneBytes(recordReply: FrameRecordReply): Uint8Array | null {
  return asU8(recordReply?.scene);
}

function recordPatches(recordReply: FrameRecordReply): FrameRecordPatch[] {
  return recordReply?.patches ?? [];
}

function preparedFrameScene(
  recordReply: FrameRecordReply,
  scene: Uint8Array,
  opts: RenderFrameOpts,
  baseValid: boolean,
  phases: string[],
  position: FramePosition,
): FramePreparation {
  const unchanged = sameSceneReply(scene, recordReply, opts, baseValid, phases, position);
  if (unchanged !== null) return { kind: "reply", reply: unchanged };
  return {
    kind: "scene",
    frame: {
      recordReply,
      scene,
      patches: recordPatches(recordReply),
      ...position,
    },
  };
}

function prepareFrameRecord(
  recordReply: FrameRecordReply,
  opts: RenderFrameOpts,
  baseValid: boolean,
  phases: string[],
): FramePreparation {
  const position = framePosition(recordReply);
  const unchanged = unchangedFrameReply(recordReply, position);
  if (unchanged !== null) return { kind: "reply", reply: unchanged };
  const scene = recordSceneBytes(recordReply);
  if (!isNonemptyBytes(scene)) {
    return { kind: "reply", reply: emptyFrameSceneReply(recordReply, phases, position) };
  }
  return preparedFrameScene(recordReply, scene, opts, baseValid, phases, position);
}

function frameSceneBytes(frame: FrameScene): Uint8Array[] {
  return [frame.scene, ...frame.patches.map((patch) => asU8(patch.scene) ?? new Uint8Array(0))];
}

function missingFrameResources(scenes: Uint8Array[]): Uint8Array {
  return concatMissing(scenes.map((sceneBytes) => rasterizer.missingResources(sceneBytes)));
}

function isPartialFrame(
  baseValid: boolean,
  recordReply: FrameRecordReply,
  clip: FrameClip | null | undefined,
): boolean {
  return baseValid && recordReply?.partial === true && !!clip;
}

function frameFormat(opts: RenderFrameOpts): string {
  return typeof opts.format === "string" ? opts.format : DEFAULT_RASTER_FORMAT;
}

function frameQuality(opts: RenderFrameOpts): number {
  return typeof opts.quality === "number" ? opts.quality | 0 : DEFAULT_RASTER_QUALITY;
}

function viewportPoint(
  rect: { x: number; y: number },
  scrollX: number,
  scrollY: number,
): [number, number] {
  return [Math.round((Number(rect.x) || 0) - scrollX), Math.round((Number(rect.y) || 0) - scrollY)];
}

function frameClip(frame: FrameScene): FrameClip | null | undefined {
  return frame.recordReply?.clip;
}

function frameShift(frame: FrameScene): FrameShift | null | undefined {
  return frame.recordReply?.shift;
}

function shiftedPartialInput(
  frame: FrameScene,
  isPartial: boolean,
): { clip: FrameClip; shift: FrameShift } | null {
  if (!isPartial) return null;
  const clip = frameClip(frame);
  if (!clip) return null;
  const shift = frameShift(frame);
  if (!shift) return null;
  return { clip, shift };
}

function renderShiftedPartialFrame(
  frame: FrameScene,
  partialKey: string,
  clip: FrameClip,
  shift: FrameShift,
  format: string,
  quality: number,
): Uint8Array | null {
  const shifted = rasterizer.shiftRetained(partialKey, shift.x | 0, shift.y | 0);
  if (!shifted) return null;
  const patches = [{ clip, scene: frame.scene }, ...frame.patches];
  const blitted = patches.every((patch) => {
    const [x, y] = viewportPoint(patch.clip, frame.scrollX, frame.scrollY);
    return rasterizer.blitPartial(asU8(patch.scene) ?? new Uint8Array(0), x, y, partialKey);
  });
  if (!blitted) return null;
  return rasterizer.encodeRetained(format, quality, partialKey);
}

function shiftedPartialIfApplicable(
  frame: FrameScene,
  partialKey: string,
  isPartial: boolean,
  format: string,
  quality: number,
): Uint8Array | null | undefined {
  const input = shiftedPartialInput(frame, isPartial);
  if (input === null) return undefined;
  return renderShiftedPartialFrame(frame, partialKey, input.clip, input.shift, format, quality);
}

function clippedPartialIfApplicable(
  frame: FrameScene,
  partialKey: string,
  isPartial: boolean,
  format: string,
  quality: number,
): Uint8Array | null | undefined {
  const clip = frameClip(frame);
  if (!isPartial || !clip) return undefined;
  const [x, y] = viewportPoint(clip, frame.scrollX, frame.scrollY);
  return rasterizer.rasterizePartial(frame.scene, x, y, format, quality, partialKey);
}

function renderFullFrame(
  scene: Uint8Array,
  opts: RenderFrameOpts,
  partialKey: string,
  format: string,
  quality: number,
): Uint8Array | null {
  if (partialKey !== "") {
    return rasterizer.rasterizeAndRetain(
      scene,
      format,
      quality,
      opts.omitBackground === true,
      partialKey,
    );
  }
  return rasterizer.rasterize(scene, format, quality, opts.omitBackground === true);
}

function renderFramePixels(
  frame: FrameScene,
  opts: RenderFrameOpts,
  partialKey: string,
  isPartial: boolean,
  format: string,
  quality: number,
): Uint8Array | null {
  const shifted = shiftedPartialIfApplicable(frame, partialKey, isPartial, format, quality);
  if (shifted !== undefined) return shifted;
  const clipped = clippedPartialIfApplicable(frame, partialKey, isPartial, format, quality);
  if (clipped !== undefined) return clipped;
  return renderFullFrame(frame.scene, opts, partialKey, format, quality);
}

function rasterizeFrame(
  frame: FrameScene,
  opts: RenderFrameOpts,
  partialKey: string,
  isPartial: boolean,
  format: string,
  quality: number,
  phases: string[],
): Uint8Array | null {
  const rasterStart = Date.now();
  try {
    return renderFramePixels(frame, opts, partialKey, isPartial, format, quality);
  } catch {
    return null;
  } finally {
    phases.push(`${isPartial ? "rasterPartial" : "raster"}=${Date.now() - rasterStart}ms`);
  }
}

function clearRetainedFrame(partialKey: string): void {
  if (partialKey === "") return;
  retainedKey = "";
  retainedSeq = -1;
  retainedScene = null;
}

function assignRetainedFrame(
  held: boolean,
  partialKey: string,
  seq: number,
  isPartial: boolean,
  scene: Uint8Array,
): void {
  retainedKey = held ? partialKey : "";
  retainedSeq = held ? seq : -1;
  retainedScene = held && !isPartial ? scene : null;
}

function updateRetainedFrame(
  partialKey: string,
  seq: number,
  isPartial: boolean,
  scene: Uint8Array,
): void {
  if (partialKey === "") return;
  const held = rasterizer.retainedFrameKey() === partialKey;
  assignRetainedFrame(held, partialKey, seq, isPartial, scene);
}

function frameRasterReply(
  frame: FrameScene,
  bytes: Uint8Array | null,
  partialKey: string,
  isPartial: boolean,
  phases: string[],
): RenderFrameReply {
  const info = rasterizer.lastRasterizeInfo();
  if (!bytes || bytes.length === 0) {
    clearRetainedFrame(partialKey);
    return {
      error: `rasterize failed: ${info}`,
      stage: "raster",
      info,
      phases,
      seq: frame.seq,
      scrollX: frame.scrollX,
      scrollY: frame.scrollY,
    };
  }
  updateRetainedFrame(partialKey, frame.seq, isPartial, frame.scene);
  return {
    bytes,
    info,
    phases,
    seq: frame.seq,
    scrollX: frame.scrollX,
    scrollY: frame.scrollY,
  };
}

interface PdfDimensions {
  paperWidth: number;
  paperHeight: number;
  margins: {
    marginTop: number;
    marginRight: number;
    marginBottom: number;
    marginLeft: number;
  };
}

type PdfRecordReply = Awaited<ReturnType<RenderPort["recordPdfScenes"]>>;
type PdfRecordRequest = { reply: PdfRecordReply } | { failure: unknown };
type PdfPreparation =
  | { kind: "reply"; reply: RenderPdfReply }
  | { kind: "envelope"; envelope: Uint8Array };

function pdfPixelSize(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value | 0) : fallback;
}

function pdfDimensions(opts: RenderPdfOpts): PdfDimensions {
  return {
    paperWidth: pdfPixelSize(opts.paperWidth, DEFAULT_PDF_PAPER_WIDTH_CSS_PX),
    paperHeight: pdfPixelSize(opts.paperHeight, DEFAULT_PDF_PAPER_HEIGHT_CSS_PX),
    margins: {
      marginTop: pdfPixelSize(opts.marginTop, DEFAULT_PDF_MARGIN_CSS_PX),
      marginRight: pdfPixelSize(opts.marginRight, DEFAULT_PDF_MARGIN_CSS_PX),
      marginBottom: pdfPixelSize(opts.marginBottom, DEFAULT_PDF_MARGIN_CSS_PX),
      marginLeft: pdfPixelSize(opts.marginLeft, DEFAULT_PDF_MARGIN_CSS_PX),
    },
  };
}

async function requestPdfRecord(
  port: RenderPort,
  dimensions: PdfDimensions,
  timed: Timed,
): Promise<PdfRecordRequest> {
  try {
    return {
      reply: await timed(
        "record",
        port.recordPdfScenes({
          width: dimensions.paperWidth,
          height: dimensions.paperHeight,
          ...dimensions.margins,
        }),
      ),
    };
  } catch (failure) {
    return { failure };
  }
}

function failedPdfRecord(failure: unknown, phases: string[]): RenderPdfReply {
  return {
    error: `recordPdfScenes rejected: ${errMsg(failure)}`,
    stage: "record",
    phases,
  };
}

function emptyPdfEnvelopeReply(recordReply: PdfRecordReply, phases: string[]): RenderPdfReply {
  return {
    error: recordReply?.error || "recordPdfScenes returned empty envelope",
    stage: "record",
    phases,
  };
}

function preparePdfEnvelope(recordReply: PdfRecordReply, phases: string[]): PdfPreparation {
  const envelope = asU8(recordReply?.envelope);
  if (!isNonemptyBytes(envelope)) {
    return { kind: "reply", reply: emptyPdfEnvelopeReply(recordReply, phases) };
  }
  return { kind: "envelope", envelope };
}

function renderPdfBytes(
  envelope: Uint8Array,
  dimensions: PdfDimensions,
  opts: RenderPdfOpts,
  phases: string[],
): Uint8Array | null {
  const pdfStart = Date.now();
  try {
    return rasterizer.renderPdf(
      envelope,
      dimensions.paperWidth,
      dimensions.paperHeight,
      opts.omitBackground === true,
      dimensions.margins.marginTop,
      dimensions.margins.marginRight,
      dimensions.margins.marginBottom,
      dimensions.margins.marginLeft,
    );
  } catch {
    return null;
  } finally {
    phases.push(`pdf=${Date.now() - pdfStart}ms`);
  }
}

function pdfRasterReply(bytes: Uint8Array | null, phases: string[]): RenderPdfReply {
  const info = rasterizer.lastRasterizeInfo();
  if (!isNonemptyBytes(bytes)) {
    return { error: `renderPdf failed: ${info}`, stage: "raster", info, phases };
  }
  return { bytes, info, phases };
}

export class PageRenderer extends WorkerEntrypoint<RendererEnv> implements PageRendererRpc {
  constructor(ctx: ExecutionContext, env: RendererEnv) {
    super(ctx, env);
    // Preallocate the initial viewport to avoid first-frame Wasm heap growth.
    if (!reservedFromEnv) {
      reservedFromEnv = true;
      reserveInitialFrame(env);
    }
  }

  ping(): { pong: number } {
    return { pong: Date.now() };
  }

  memoryStats(): { bytes: number; initialBytes: number; deltaBytes: number } {
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
      return await this.renderFrameImpl(port, opts, fetchAsset, fetchImage, fetchFont);
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
    const partialKey = framePartialKey(opts);
    // Request partial scenes only while JavaScript and Wasm agree on the retained base key.
    const baseValid = retainedBaseIsValid(partialKey);
    const record = await requestFrameRecord(port, opts, baseValid, timed);
    if ("failure" in record) return failedFrameRecord(record.failure, phases);
    const preparation = prepareFrameRecord(record.reply, opts, baseValid, phases);
    if (preparation.kind === "reply") return preparation.reply;
    const frame = preparation.frame;
    const scenes = frameSceneBytes(frame);
    const unresolved = await resolveResources(
      () => missingFrameResources(scenes),
      port,
      fetchAsset,
      fetchImage,
      fetchFont,
      timed,
    );
    if (unresolved) {
      return {
        ...unresolved,
        phases,
        seq: frame.seq,
        scrollX: frame.scrollX,
        scrollY: frame.scrollY,
      };
    }
    const clip = frame.recordReply?.clip;
    const isPartial = isPartialFrame(baseValid, frame.recordReply, clip);
    const bytes = rasterizeFrame(
      frame,
      opts,
      partialKey,
      isPartial,
      frameFormat(opts),
      frameQuality(opts),
      phases,
    );
    return frameRasterReply(frame, bytes, partialKey, isPartial, phases);
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
      return await this.renderPdfImpl(port, opts, fetchAsset, fetchImage, fetchFont);
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
    const dimensions = pdfDimensions(opts);
    const record = await requestPdfRecord(port, dimensions, timed);
    if ("failure" in record) return failedPdfRecord(record.failure, phases);
    const preparation = preparePdfEnvelope(record.reply, phases);
    if (preparation.kind === "reply") return preparation.reply;
    const envelope = preparation.envelope;
    const unresolved = await resolveResources(
      () => rasterizer.missingResourcesPdf(envelope),
      port,
      fetchAsset,
      fetchImage,
      fetchFont,
      timed,
    );
    if (unresolved) return { ...unresolved, phases };
    const bytes = renderPdfBytes(envelope, dimensions, opts, phases);
    return pdfRasterReply(bytes, phases);
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
