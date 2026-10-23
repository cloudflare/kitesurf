// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Handles Kitesurf CDP methods for scene transfer, engine settings, and diagnostics.

import type { Protocol } from "devtools-protocol";
import type { DispatchCtx } from "./dispatch.ts";
import type { CdpMethod, CdpRequest, CdpResultOf, TargetState } from "./types.ts";
import { CDP_COMMAND_UNHANDLED } from "./types.ts";
import {
  sessionOf,
  stubQueryDom,
  type QueryDomCarrier,
  type QueryDomMethod,
  type QueryDomResult,
} from "./page-session.ts";
import { engineMemoryBreakdown } from "./target.ts";
import { sceneStreamCommand } from "./scene-stream.ts";
import { sceneHostCommand } from "./scene-host.ts";
import {
  MAX_MISSING_RESOURCE_LIST_B64_CHARS,
  MISSING_RESOURCE_LIST_ENTRY_BYTES,
  MISSING_RESOURCE_LIST_HEADER_BYTES,
  MISSING_RESOURCE_LIST_KIND_BYTES,
} from "../rbi-protocol.ts";

function bytesToBase64(bytes: Uint8Array): string {
  return bytes.toBase64();
}
function base64ToBytes(s: string): Uint8Array {
  return Uint8Array.fromBase64(s);
}

function firstPageTarget(ctx: DispatchCtx): TargetState | null {
  for (const t of ctx.browser.targets.values()) {
    if (t.type === "page") return t;
  }
  return null;
}

function splitMissingHashes(missing: Uint8Array): {
  imageHashes: Uint8Array;
  fontDataHashes: Uint8Array;
} {
  if (missing.byteLength < MISSING_RESOURCE_LIST_HEADER_BYTES) {
    return { imageHashes: new Uint8Array(0), fontDataHashes: new Uint8Array(0) };
  }
  const view = new DataView(missing.buffer, missing.byteOffset, missing.byteLength);
  const count = view.getUint32(0, true);
  const images: number[] = [];
  const fonts: number[] = [];
  let off = MISSING_RESOURCE_LIST_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    if (!hasMissingResourceEntry(off, missing.byteLength)) break;
    const kind = view.getUint8(off);
    const hashBytes = missing.subarray(
      off + MISSING_RESOURCE_LIST_KIND_BYTES,
      off + MISSING_RESOURCE_LIST_ENTRY_BYTES,
    );
    appendMissingHash(kind, hashBytes, images, fonts);
    off += MISSING_RESOURCE_LIST_ENTRY_BYTES;
  }
  return {
    imageHashes: new Uint8Array(images),
    fontDataHashes: new Uint8Array(fonts),
  };
}

function hasMissingResourceEntry(offset: number, byteLength: number): boolean {
  return offset + MISSING_RESOURCE_LIST_ENTRY_BYTES <= byteLength;
}

function appendMissingHash(
  kind: number,
  hashBytes: Uint8Array,
  images: number[],
  fonts: number[],
): void {
  if (kind === 2) images.push(...hashBytes);
  else if (kind === 3) fonts.push(...hashBytes);
}

function coerceMode(raw: unknown): Protocol.Kitesurf.LayoutMode {
  if (typeof raw !== "string") return "full";
  const lower = raw.toLowerCase();
  if (lower === "off" || lower === "0" || lower === "false") return "off";
  return "full";
}

function targetIdOf(params: { targetId?: unknown } | undefined): string | null {
  return typeof params?.targetId === "string" ? params.targetId : null;
}

// Target-scoped page methods default to the first page, as the other Kitesurf methods do.
function pageTargetFor(
  ctx: DispatchCtx,
  params: { targetId?: unknown } | undefined,
): TargetState | null {
  const targetId = targetIdOf(params);
  const target =
    targetId === null ? firstPageTarget(ctx) : (ctx.browser.targets.get(targetId) ?? null);
  return target?.type === "page" ? target : null;
}

function noPageScript(target: TargetState | null): string {
  return target ? "no PageScript" : "target not found";
}

// paintDamageSince always takes a node to leave out; this external id is never minted.
const NO_EXCLUDED_NODE = 0xffff_ffff;

function positiveNodeId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const OUTBOUND_FILTER_FIELDS = [
  "allowRequestPattern",
  "rejectRequestPattern",
  "allowResourceTypes",
  "rejectResourceTypes",
] as const;

function cdpResult<M extends CdpMethod>(
  _req: { method: M },
  result: CdpResultOf<M>,
): CdpResultOf<M> {
  return result;
}

const PAGE_DIAGNOSTIC_OPS = {
  "Kitesurf.getFontFaces": "getFontFaces",
  "Kitesurf.getMemprofDump": "getMemprofDump",
  "Kitesurf.resetMemprof": "resetMemprof",
  "Kitesurf.boaForceCollect": "boaForceCollect",
  "Kitesurf.getSceneStats": "getSceneStats",
} as const satisfies Partial<Record<CdpRequest["method"], QueryDomMethod>>;

type KitesurfMethod = Extract<CdpRequest["method"], `Kitesurf.${string}`>;
type KitesurfRequest<M extends KitesurfMethod> = Extract<CdpRequest, { method: M }>;
type KitesurfCommandHandler = (ctx: DispatchCtx, req: CdpRequest) => Promise<unknown> | unknown;
type PageDiagnosticMethod = keyof typeof PAGE_DIAGNOSTIC_OPS;
type PageDiagnosticRequest = KitesurfRequest<PageDiagnosticMethod>;
type RendererManager = NonNullable<DispatchCtx["browser"]["rendererManager"]>;
type RendererMemoryStats = Awaited<ReturnType<RendererManager["memoryStats"]>>;

const EMPTY_RENDERER_MEMORY = { bytes: 0, initialBytes: 0, deltaBytes: 0 } as const;

export async function handleKitesurf(ctx: DispatchCtx, req: CdpRequest): Promise<unknown> {
  const handler = KITESURF_HANDLERS[req.method];
  if (!handler) return CDP_COMMAND_UNHANDLED;
  return handler(ctx, req);
}

function hasKitesurfMethod<M extends KitesurfMethod>(
  req: CdpRequest,
  method: M,
): req is KitesurfRequest<M> {
  return req.method === method;
}

function commandHandler<M extends KitesurfMethod>(
  method: M,
  handler: (ctx: DispatchCtx, req: KitesurfRequest<M>) => Promise<unknown> | unknown,
): KitesurfCommandHandler {
  return (ctx, req) => {
    if (!hasKitesurfMethod(req, method)) return CDP_COMMAND_UNHANDLED;
    return handler(ctx, req);
  };
}

async function handleSetLayoutMode(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.setLayoutMode">,
): Promise<unknown> {
  const mode = coerceMode(req.params?.mode);
  const targetId = targetIdOf(req.params);
  if (targetId === null) return updateBrowserLayoutMode(ctx, req, mode);
  const target = ctx.browser.targets.get(targetId);
  if (!target) {
    return cdpResult(req, { mode, scope: "target", targetId, error: "target not found" });
  }
  return updateTargetLayoutMode(ctx, req, target, targetId, mode);
}

async function updateBrowserLayoutMode(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.setLayoutMode">,
  mode: Protocol.Kitesurf.LayoutMode,
): Promise<unknown> {
  ctx.browser.layoutMode = mode;
  const updated: string[] = [];
  for (const target of ctx.browser.targets.values()) {
    target.layoutMode = mode;
    if (target.type === "page") {
      await sessionOf(ctx, target).callIfLive.setLayoutMode({ mode });
    }
    updated.push(target.targetId);
  }
  return cdpResult(req, { mode, scope: "browser", targets: updated });
}

async function updateTargetLayoutMode(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.setLayoutMode">,
  target: TargetState,
  targetId: string,
  mode: Protocol.Kitesurf.LayoutMode,
): Promise<unknown> {
  target.layoutMode = mode;
  if (target.type === "page" && target.pageScript) {
    try {
      await stubQueryDom(target.pageScript, "setLayoutMode", { mode });
    } catch (err) {
      return cdpResult(req, { mode, scope: "target", targetId, error: errorText(err) });
    }
  }
  return cdpResult(req, { mode, scope: "target", targetId });
}

async function handleGetLayoutMode(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.getLayoutMode">,
): Promise<unknown> {
  const targetId = targetIdOf(req.params);
  if (targetId === null) return cdpResult(req, { mode: ctx.browser.layoutMode });
  const target = ctx.browser.targets.get(targetId);
  if (!target) return cdpResult(req, { mode: ctx.browser.layoutMode, error: "target not found" });
  const mode = await pageLayoutMode(ctx, target);
  if (mode !== null) return cdpResult(req, { mode });
  return cdpResult(req, { mode: target.layoutMode });
}

async function pageLayoutMode(ctx: DispatchCtx, target: TargetState): Promise<string | null> {
  if (target.type !== "page") return null;
  const reply = await sessionOf(ctx, target).callIfLive.getLayoutMode({});
  if (reply && typeof reply.mode === "string") return reply.mode;
  return null;
}

async function handleGetRendererInfo(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.getRendererInfo">,
): Promise<unknown> {
  const manager = ctx.browser.rendererManager;
  if (!manager) return missingRendererInfo(req, ctx.browser.skipPartialRaster);
  return activeRendererInfo(ctx, req, manager);
}

function missingRendererInfo(
  req: KitesurfRequest<"Kitesurf.getRendererInfo">,
  skipPartialRaster: boolean,
): unknown {
  return cdpResult(req, {
    enabled: true,
    active: false,
    framesRendered: 0,
    partialFramesRendered: 0,
    relaunchCount: 0,
    rendererWasmBytes: null,
    rendererWasmDeltaBytes: null,
    initialRes: null,
    partialRaster: !skipPartialRaster,
  });
}

async function activeRendererInfo(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.getRendererInfo">,
  manager: RendererManager,
): Promise<unknown> {
  const memory = await manager.memoryStats();
  return cdpResult(req, {
    enabled: true,
    active: true,
    framesRendered: manager.framesRendered,
    partialFramesRendered: manager.partialFramesRendered,
    relaunchCount: manager.relaunchCount,
    ...rendererInfoMemoryFields(memory),
    initialRes: manager.initialResString(),
    partialRaster: !ctx.browser.skipPartialRaster,
  });
}

function rendererInfoMemoryFields(memory: RendererMemoryStats): {
  rendererWasmBytes: number | null;
  rendererWasmDeltaBytes: number | null;
} {
  if (!memory) return { rendererWasmBytes: null, rendererWasmDeltaBytes: null };
  return { rendererWasmBytes: memory.bytes, rendererWasmDeltaBytes: memory.deltaBytes };
}

async function handleGetNavigatePhases(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.getNavigatePhases">,
): Promise<unknown> {
  const targetId = targetIdOf(req.params);
  if (targetId === null) return cdpResult(req, { byTarget: allNavigatePhases(ctx) });
  const target = ctx.browser.targets.get(targetId);
  if (!target) return cdpResult(req, { phases: null, error: "target not found" });
  return cdpResult(req, { phases: target.lastNavigatePhases });
}

function allNavigatePhases(
  ctx: DispatchCtx,
): Record<string, Protocol.Kitesurf.NavigatePhases | null> {
  const byTarget: Record<string, Protocol.Kitesurf.NavigatePhases | null> = {};
  for (const target of ctx.browser.targets.values()) {
    if (target.type !== "page") continue;
    byTarget[target.targetId] = target.lastNavigatePhases;
  }
  return byTarget;
}

async function handlePendingCriticalResources(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.hasPendingCriticalResources">,
): Promise<unknown> {
  const targetId = targetIdOf(req.params);
  if (targetId === null) {
    return cdpResult(req, { byTarget: await allPendingCriticalResources(ctx) });
  }
  const target = ctx.browser.targets.get(targetId);
  if (!target) return cdpResult(req, { pending: false, error: "target not found" });
  return cdpResult(req, (await pendingCriticalResourcesForTarget(ctx, target)) ?? {});
}

async function allPendingCriticalResources(
  ctx: DispatchCtx,
): Promise<Record<string, Protocol.Kitesurf.PendingCriticalResources | null>> {
  const byTarget: Record<string, Protocol.Kitesurf.PendingCriticalResources | null> = {};
  for (const target of ctx.browser.targets.values()) {
    if (target.type !== "page") continue;
    byTarget[target.targetId] = await pendingCriticalResourcesForTarget(ctx, target);
  }
  return byTarget;
}

async function pendingCriticalResourcesForTarget(
  ctx: DispatchCtx,
  target: TargetState,
): Promise<Protocol.Kitesurf.PendingCriticalResources | null> {
  if (target.type !== "page") return null;
  if (!target.pageScript) return { pending: false, error: "no PageScript" };
  try {
    const reply = await stubQueryDom(target.pageScript, "hasPendingCriticalResources", {});
    return pendingCriticalResourcesReply(reply);
  } catch (err) {
    return { pending: false, error: errorText(err) };
  }
}

function pendingCriticalResourcesReply(
  reply: QueryDomResult<"hasPendingCriticalResources"> | null | undefined,
): Protocol.Kitesurf.PendingCriticalResources {
  return { pending: !!reply?.pending, error: reply?.error };
}

async function handleGetPageState(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.getPageState">,
): Promise<unknown> {
  const target = pageTargetFor(ctx, req.params);
  if (!target?.pageScript) return cdpResult(req, { error: noPageScript(target) });
  try {
    const reply = await stubQueryDom(target.pageScript, "getPageState", {});
    return cdpResult(req, reply ?? {});
  } catch (err) {
    return cdpResult(req, { error: errorText(err) });
  }
}

async function handleSetControlValue(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.setControlValue">,
): Promise<unknown> {
  const nodeId = positiveNodeId(req.params?.nodeId);
  if (nodeId === null) return cdpResult(req, { changed: false, error: "bad nodeId" });
  const target = pageTargetFor(ctx, req.params);
  return setControlValueForPage(req, target, nodeId);
}

async function setControlValueForPage(
  req: KitesurfRequest<"Kitesurf.setControlValue">,
  target: TargetState | null,
  nodeId: number,
): Promise<unknown> {
  if (!target?.pageScript) {
    return cdpResult(req, { changed: false, error: noPageScript(target) });
  }
  try {
    const reply = await stubQueryDom(target.pageScript, "setControlValueAsUser", {
      nodeId,
      value: req.params?.value,
    });
    return cdpResult(req, controlValueReply(reply));
  } catch (err) {
    return cdpResult(req, { changed: false, error: errorText(err) });
  }
}

function controlValueReply(reply: QueryDomResult<"setControlValueAsUser"> | null | undefined): {
  changed: boolean;
  value?: string;
  error?: string;
} {
  return { changed: reply?.changed === true, value: reply?.value, error: reply?.error };
}

async function handleMarkPaintDamage(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.markPaintDamage">,
): Promise<unknown> {
  const target = pageTargetFor(ctx, req.params);
  if (!target?.pageScript) return cdpResult(req, { error: noPageScript(target) });
  try {
    await stubQueryDom(target.pageScript, "markPaintDamage", {});
    return cdpResult(req, {});
  } catch (err) {
    return cdpResult(req, { error: errorText(err) });
  }
}

function requestedDamageNodeId(raw: unknown): number | null {
  return raw === undefined ? NO_EXCLUDED_NODE : positiveNodeId(raw);
}

async function handleGetPaintDamageSince(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.getPaintDamageSince">,
): Promise<unknown> {
  const nodeId = requestedDamageNodeId(req.params?.excludeNodeId);
  if (nodeId === null) {
    return cdpResult(req, { nodeIds: [], overflow: false, error: "bad nodeId" });
  }
  const target = pageTargetFor(ctx, req.params);
  if (!target?.pageScript) {
    return cdpResult(req, { nodeIds: [], overflow: false, error: noPageScript(target) });
  }
  return paintDamageSinceForPage(req, target.pageScript, nodeId);
}

async function paintDamageSinceForPage(
  req: KitesurfRequest<"Kitesurf.getPaintDamageSince">,
  pageScript: NonNullable<TargetState["pageScript"]>,
  nodeId: number,
): Promise<unknown> {
  try {
    const reply = await stubQueryDom(pageScript, "paintDamageSince", { nodeId });
    return cdpResult(req, paintDamageSinceReply(reply));
  } catch (err) {
    return cdpResult(req, { nodeIds: [], overflow: false, error: errorText(err) });
  }
}

function paintDamageSinceReply(reply: QueryDomResult<"paintDamageSince"> | null | undefined): {
  nodeIds: number[];
  overflow: boolean;
} {
  return {
    nodeIds: Array.isArray(reply?.ids) ? reply.ids : [],
    overflow: reply?.overflow === true,
  };
}

async function handleGetMemoryStats(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.getMemoryStats">,
): Promise<unknown> {
  const targetId = targetIdOf(req.params);
  if (targetId === null) return allMemoryStats(ctx, req);
  const target = ctx.browser.targets.get(targetId);
  if (!target) return cdpResult(req, { wasmBytes: 0, error: "target not found" });
  return cdpResult(req, (await memoryStatsForTarget(ctx, target)) ?? {});
}

async function allMemoryStats(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.getMemoryStats">,
): Promise<unknown> {
  const byTarget = await allPageMemoryStats(ctx);
  const pageScript = totalPageMemoryStats(byTarget);
  const engine = engineMemoryBreakdown(ctx.browser);
  const renderer = await rendererMemoryNumbers(ctx.browser.rendererManager);
  return cdpResult(req, {
    byTarget,
    engine,
    renderer,
    isolatesKilled: ctx.browser.workerBudget.isolatesKilled,
    total: {
      bytes: engine.accountedBytes + pageScript.wasmBytes + renderer.wasmBytes,
      deltaBytes: engine.wasmDeltaBytes + pageScript.wasmDeltaBytes + renderer.wasmDeltaBytes,
      engineBytes: engine.accountedBytes,
      pageScriptBytes: pageScript.wasmBytes,
      rendererBytes: renderer.wasmBytes,
    },
  });
}

async function allPageMemoryStats(
  ctx: DispatchCtx,
): Promise<Record<string, Protocol.Kitesurf.MemoryStats | null>> {
  const byTarget: Record<string, Protocol.Kitesurf.MemoryStats | null> = {};
  for (const target of ctx.browser.targets.values()) {
    if (target.type !== "page") continue;
    byTarget[target.targetId] = await memoryStatsForTarget(ctx, target);
  }
  return byTarget;
}

function totalPageMemoryStats(byTarget: Record<string, Protocol.Kitesurf.MemoryStats | null>): {
  wasmBytes: number;
  wasmDeltaBytes: number;
} {
  let wasmBytes = 0;
  let wasmDeltaBytes = 0;
  for (const stats of Object.values(byTarget)) {
    if (!stats) continue;
    wasmBytes += numberOrZero(stats.wasmBytes) + numberOrZero(stats.frameWasmBytes);
    wasmDeltaBytes += numberOrZero(stats.wasmDeltaBytes) + numberOrZero(stats.frameWasmDeltaBytes);
  }
  return { wasmBytes, wasmDeltaBytes };
}

async function memoryStatsForTarget(
  ctx: DispatchCtx,
  target: TargetState,
): Promise<Protocol.Kitesurf.MemoryStats | null> {
  if (target.type !== "page") return null;
  if (!target.pageScript) return noPageScriptMemoryStats();
  return memoryStatsWithFrames(target, target.pageScript);
}

function noPageScriptMemoryStats(): Protocol.Kitesurf.MemoryStats {
  return {
    wasmBytes: 0,
    wasmInitialBytes: 0,
    wasmDeltaBytes: 0,
    frameWasmBytes: 0,
    frameWasmDeltaBytes: 0,
    error: "no PageScript",
  };
}

async function memoryStatsWithFrames(
  target: TargetState,
  pageScript: NonNullable<TargetState["pageScript"]>,
): Promise<Protocol.Kitesurf.MemoryStats> {
  const children = [...target.frames.values()]
    .map((frame) => frame.pageScript)
    .filter((stub): stub is NonNullable<typeof stub> => Boolean(stub));
  const [own, ...replies] = await Promise.all([
    memoryStatsForStub(pageScript),
    ...children.map(memoryStatsForStub),
  ]);
  return memoryStatsWithFrameTotals(own, replies);
}

async function memoryStatsForStub(stub: QueryDomCarrier): Promise<Protocol.Kitesurf.MemoryStats> {
  try {
    const reply = await stubQueryDom(stub, "getMemoryStats", {});
    return memoryStatsFromReply(reply);
  } catch (err) {
    return failedMemoryStats(err);
  }
}

function memoryStatsFromReply(
  reply: QueryDomResult<"getMemoryStats"> | null | undefined,
): Protocol.Kitesurf.MemoryStats {
  if (!reply) return emptyPageMemoryStats();
  return {
    ...memoryByteFields(reply),
    ...memoryDomFields(reply),
    ...memoryPaintFields(reply),
    error: reply.error,
  };
}

function emptyPageMemoryStats(): Protocol.Kitesurf.MemoryStats {
  return {
    wasmBytes: 0,
    wasmInitialBytes: 0,
    wasmDeltaBytes: 0,
    bridge: null,
    domFastpath: null,
    domNodes: null,
    wrappers: null,
    paint: null,
    intersectionObserver: null,
    timerWheel: null,
  };
}

function memoryByteFields(reply: QueryDomResult<"getMemoryStats">): {
  wasmBytes: number;
  wasmInitialBytes: number;
  wasmDeltaBytes: number;
} {
  return {
    wasmBytes: numberOrZero(reply.bytes),
    wasmInitialBytes: numberOrZero(reply.initialBytes),
    wasmDeltaBytes: numberOrZero(reply.deltaBytes),
  };
}

function memoryDomFields(reply: QueryDomResult<"getMemoryStats">) {
  return {
    bridge: reply.bridge ?? null,
    domFastpath: reply.domFastpath ?? null,
    domNodes: numberOrNull(reply.domNodes),
    wrappers: reply.wrappers ?? null,
  };
}

function memoryPaintFields(reply: QueryDomResult<"getMemoryStats">) {
  return {
    paint: reply.paint ?? null,
    intersectionObserver: reply.intersectionObserver ?? null,
    timerWheel: reply.timerWheel ?? null,
  };
}

function numberOrZero(value: number | undefined): number {
  return typeof value === "number" ? value : 0;
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" ? value : null;
}

function failedMemoryStats(err: unknown): Protocol.Kitesurf.MemoryStats {
  return {
    wasmBytes: 0,
    wasmInitialBytes: 0,
    wasmDeltaBytes: 0,
    error: errorText(err),
  };
}

function memoryStatsWithFrameTotals(
  own: Protocol.Kitesurf.MemoryStats,
  replies: Protocol.Kitesurf.MemoryStats[],
): Protocol.Kitesurf.MemoryStats {
  let frameWasmBytes = 0;
  let frameWasmDeltaBytes = 0;
  for (const child of replies) {
    frameWasmBytes += child.wasmBytes ?? 0;
    frameWasmDeltaBytes += child.wasmDeltaBytes ?? 0;
  }
  return { ...own, frameWasmBytes, frameWasmDeltaBytes };
}

function rendererMemoryValues(memory: RendererMemoryStats): {
  wasmBytes: number;
  wasmInitialBytes: number;
  wasmDeltaBytes: number;
} {
  const values = memory ?? EMPTY_RENDERER_MEMORY;
  return {
    wasmBytes: values.bytes,
    wasmInitialBytes: values.initialBytes,
    wasmDeltaBytes: values.deltaBytes,
  };
}

async function rendererMemoryNumbers(
  manager: RendererManager | null,
): Promise<{ wasmBytes: number; wasmInitialBytes: number; wasmDeltaBytes: number }> {
  if (!manager) return rendererMemoryValues(null);
  return rendererMemoryValues(await manager.memoryStats());
}

async function handleSetOutboundFilters(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.setOutboundFilters">,
): Promise<unknown> {
  const { compileOutboundFilters, registerOutboundFilters } =
    await import("./outbound-filter-registry.ts");
  const parsed = outboundFilterInput(req.params);
  if (!parsed.ok) return cdpResult(req, { ok: false, error: parsed.error });
  const compiled = compileOutboundFilters(parsed.input);
  if (!compiled.ok) return cdpResult(req, { ok: false, error: compiled.error });
  registerOutboundFilters(ctx.connectionId, compiled.filters);
  return cdpResult(req, { ok: true });
}

function outboundFilterInput(params: KitesurfRequest<"Kitesurf.setOutboundFilters">["params"]):
  | {
      ok: true;
      input: Partial<Record<(typeof OUTBOUND_FILTER_FIELDS)[number], string[]>>;
    }
  | { ok: false; error: string } {
  const values = params ?? {};
  const input: Partial<Record<(typeof OUTBOUND_FILTER_FIELDS)[number], string[]>> = {};
  for (const name of OUTBOUND_FILTER_FIELDS) {
    const parsed = parseOutboundFilterValue(name, values[name]);
    if (!parsed.ok) return parsed;
    if (parsed.strings) input[name] = parsed.strings;
  }
  return { ok: true, input };
}

function parseOutboundFilterValue(
  name: string,
  value: unknown,
): { ok: true; strings: string[] | null } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: true, strings: null };
  const strings = value.filter((item): item is string => typeof item === "string");
  if (strings.length !== value.length) {
    return { ok: false, error: `${name} must be an array of strings` };
  }
  return { ok: true, strings };
}

function requestedTarget(
  ctx: DispatchCtx,
  params: { targetId?: unknown } | undefined,
): TargetState | null {
  const targetId = targetIdOf(params);
  if (targetId) return ctx.browser.targets.get(targetId) ?? null;
  return firstPageTarget(ctx);
}

async function handleRecordScene(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.recordScene">,
): Promise<unknown> {
  const target = requestedTarget(ctx, req.params);
  if (!target || target.type !== "page") return cdpResult(req, { error: "no page target" });
  if (!target.pageScript) return cdpResult(req, { error: "no PageScript" });
  return recordSceneForPage(req, target.pageScript);
}

async function recordSceneForPage(
  req: KitesurfRequest<"Kitesurf.recordScene">,
  pageScript: NonNullable<TargetState["pageScript"]>,
): Promise<unknown> {
  const params = req.params ?? {};
  const args = {
    producer: params.producer,
    sinceSeq: params.sinceSeq,
    omitBackground: params.omitBackground,
    clip: params.clip,
    allowPartial: params.allowPartial,
    allowScrollShift: params.allowScrollShift,
    baseSeq: params.baseSeq,
    inlineResources: params.inlineResources,
    pumpRaf: params.pumpRaf,
    frameIntervalMs: params.frameIntervalMs,
  };
  try {
    const reply = await stubQueryDom(pageScript, "recordScene", args);
    return cdpResult(req, recordSceneReply(reply));
  } catch (err) {
    return cdpResult(req, { error: errorText(err) });
  }
}

function recordSceneReply(reply: QueryDomResult<"recordScene">) {
  return {
    sceneB64: bytesToBase64IfPresent(reply.scene),
    resourceBatchB64: bytesToBase64IfPresent(reply.resourceBatch),
    unchanged: !!reply.unchanged,
    seq: valueOrDefault(reply.seq, 0),
    partial: !!reply.partial,
    clip: valueOrDefault(reply.clip, null),
    baseSeq: valueOrDefault(reply.baseSeq, -1),
    scrollX: valueOrDefault(reply.scrollX, 0),
    scrollY: valueOrDefault(reply.scrollY, 0),
    error: reply.error,
    damageCount: valueOrDefault(reply.damageCount, 0),
    layoutDirty: !!reply.layoutDirty,
    skipReason: valueOrDefault(reply.skipReason, ""),
  };
}

function bytesToBase64IfPresent(bytes: Uint8Array | null | undefined): string {
  if (!bytes || bytes.length === 0) return "";
  return bytesToBase64(bytes);
}

function valueOrDefault<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

async function handleGetScreencastStatus(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.getScreencastStatus">,
): Promise<unknown> {
  const target = requestedTarget(ctx, req.params);
  if (!target) return cdpResult(req, { error: "no page target" });
  const where = screencastLocation(ctx, target);
  const screencast = ctx.browser.screencasts.get(target.targetId);
  if (!screencast) return cdpResult(req, { active: false, ...where });
  return cdpResult(req, {
    active: !screencast.stopped,
    framesDropped: screencast.framesDropped,
    lastError: screencast.lastRenderError ?? "",
    inFlight: screencast.frameSeq - screencast.lastAckedSeq,
    ...where,
  });
}

function screencastLocation(ctx: DispatchCtx, target: TargetState) {
  return {
    targetId: target.targetId,
    targetUrl: target.url,
    hasPageScript: target.pageScript !== null,
    generation: target.navigateGeneration,
    pageTargets: [...ctx.browser.targets.values()].filter((item) => item.type === "page").length,
  };
}

async function handleGetRbiResources(
  ctx: DispatchCtx,
  req: KitesurfRequest<"Kitesurf.getRbiResources">,
): Promise<unknown> {
  const target = requestedTarget(ctx, req.params);
  if (!target) return cdpResult(req, { error: "no page target" });
  if (target.type !== "page") return cdpResult(req, { error: "no page target" });
  return getRbiResourcesForPage(req, target);
}

async function getRbiResourcesForPage(
  req: KitesurfRequest<"Kitesurf.getRbiResources">,
  target: TargetState,
): Promise<unknown> {
  if (!target.pageScript) return cdpResult(req, { error: "no PageScript" });
  const missingB64Param = req.params?.missingB64;
  const missingB64 = typeof missingB64Param === "string" ? missingB64Param : "";
  if (missingB64.length > MAX_MISSING_RESOURCE_LIST_B64_CHARS) {
    return cdpResult(req, { error: "missing list too large" });
  }
  const missing = base64ToBytes(missingB64);
  const hashes = splitMissingHashes(missing);
  return getPaintResourcesForPage(req, target.pageScript, hashes);
}

async function getPaintResourcesForPage(
  req: KitesurfRequest<"Kitesurf.getRbiResources">,
  pageScript: NonNullable<TargetState["pageScript"]>,
  hashes: { imageHashes: Uint8Array; fontDataHashes: Uint8Array },
): Promise<unknown> {
  try {
    const reply = await stubQueryDom(pageScript, "getPaintResources", hashes);
    return cdpResult(req, { batchB64: bytesToBase64IfPresent(reply.batch), error: reply.error });
  } catch (err) {
    return cdpResult(req, { error: errorText(err) });
  }
}

async function handlePageDiagnostics(
  ctx: DispatchCtx,
  req: PageDiagnosticRequest,
): Promise<unknown> {
  const op = PAGE_DIAGNOSTIC_OPS[req.method];
  const targetId = targetIdOf(req.params);
  if (targetId === null) return { byTarget: await allPageDiagnostics(ctx, op) };
  const target = ctx.browser.targets.get(targetId);
  if (!target) return { error: "target not found" };
  return (await pageDiagnosticForTarget(target, op)) ?? {};
}

async function allPageDiagnostics(
  ctx: DispatchCtx,
  op: QueryDomMethod,
): Promise<Record<string, Awaited<ReturnType<typeof pageDiagnosticForTarget>>>> {
  const byTarget: Record<string, Awaited<ReturnType<typeof pageDiagnosticForTarget>>> = {};
  for (const target of ctx.browser.targets.values()) {
    if (target.type !== "page") continue;
    byTarget[target.targetId] = await pageDiagnosticForTarget(target, op);
  }
  return byTarget;
}

async function pageDiagnosticForTarget(target: TargetState, op: QueryDomMethod) {
  if (target.type !== "page") return null;
  if (!target.pageScript) return { error: "no PageScript" };
  try {
    return await stubQueryDom(target.pageScript, op, {});
  } catch (err) {
    return { error: errorText(err) };
  }
}

const KITESURF_HANDLERS: Partial<Record<CdpRequest["method"], KitesurfCommandHandler>> = {
  "Kitesurf.getSceneHostManifest": commandHandler("Kitesurf.getSceneHostManifest", (ctx, req) =>
    sceneHostCommand(ctx.env.FONT_ASSETS, req, ctx.browser),
  ),
  "Kitesurf.readSceneHost": commandHandler("Kitesurf.readSceneHost", (ctx, req) =>
    sceneHostCommand(ctx.env.FONT_ASSETS, req, ctx.browser),
  ),
  "Kitesurf.startSceneStream": commandHandler("Kitesurf.startSceneStream", sceneStreamCommand),
  "Kitesurf.stopSceneStream": commandHandler("Kitesurf.stopSceneStream", sceneStreamCommand),
  "Kitesurf.sceneFrameAck": commandHandler("Kitesurf.sceneFrameAck", sceneStreamCommand),
  "Kitesurf.getSceneResources": commandHandler("Kitesurf.getSceneResources", sceneStreamCommand),
  "Kitesurf.getSessionInfo": commandHandler("Kitesurf.getSessionInfo", (ctx, req) => {
    const meta = ctx.analytics.meta;
    return cdpResult(req, {
      sessionId: meta.sessionId,
      entrypoint: meta.entrypoint,
      connectionMode: meta.connectionMode,
      environment: meta.environment,
      buildVersion: meta.buildVersion,
      colo: meta.colo,
    });
  }),
  "Kitesurf.setLayoutMode": commandHandler("Kitesurf.setLayoutMode", handleSetLayoutMode),
  "Kitesurf.getLayoutMode": commandHandler("Kitesurf.getLayoutMode", handleGetLayoutMode),
  "Kitesurf.getRendererInfo": commandHandler("Kitesurf.getRendererInfo", handleGetRendererInfo),
  "Kitesurf.setPartialRaster": commandHandler("Kitesurf.setPartialRaster", (ctx, req) => {
    const enabled = req.params?.enabled !== false;
    ctx.browser.skipPartialRaster = !enabled;
    return cdpResult(req, { enabled });
  }),
  "Kitesurf.disposeRenderer": commandHandler("Kitesurf.disposeRenderer", (ctx, req) => {
    const manager = ctx.browser.rendererManager;
    if (manager) manager.dispose("Kitesurf.disposeRenderer");
    return cdpResult(req, { disposed: !!manager });
  }),
  "Kitesurf.getNavigatePhases": commandHandler(
    "Kitesurf.getNavigatePhases",
    handleGetNavigatePhases,
  ),
  "Kitesurf.hasPendingCriticalResources": commandHandler(
    "Kitesurf.hasPendingCriticalResources",
    handlePendingCriticalResources,
  ),
  "Kitesurf.getPageState": commandHandler("Kitesurf.getPageState", handleGetPageState),
  "Kitesurf.setControlValue": commandHandler("Kitesurf.setControlValue", handleSetControlValue),
  "Kitesurf.markPaintDamage": commandHandler("Kitesurf.markPaintDamage", handleMarkPaintDamage),
  "Kitesurf.getPaintDamageSince": commandHandler(
    "Kitesurf.getPaintDamageSince",
    handleGetPaintDamageSince,
  ),
  "Kitesurf.getMemoryStats": commandHandler("Kitesurf.getMemoryStats", handleGetMemoryStats),
  "Kitesurf.setOutboundFilters": commandHandler(
    "Kitesurf.setOutboundFilters",
    handleSetOutboundFilters,
  ),
  "Kitesurf.recordScene": commandHandler("Kitesurf.recordScene", handleRecordScene),
  "Kitesurf.getScreencastStatus": commandHandler(
    "Kitesurf.getScreencastStatus",
    handleGetScreencastStatus,
  ),
  "Kitesurf.getConnectionInfo": commandHandler("Kitesurf.getConnectionInfo", (ctx, req) =>
    cdpResult(req, { connectionId: ctx.connectionId }),
  ),
  "Kitesurf.getRbiResources": commandHandler("Kitesurf.getRbiResources", handleGetRbiResources),
  "Kitesurf.getFontFaces": commandHandler("Kitesurf.getFontFaces", handlePageDiagnostics),
  "Kitesurf.getMemprofDump": commandHandler("Kitesurf.getMemprofDump", handlePageDiagnostics),
  "Kitesurf.resetMemprof": commandHandler("Kitesurf.resetMemprof", handlePageDiagnostics),
  "Kitesurf.boaForceCollect": commandHandler("Kitesurf.boaForceCollect", handlePageDiagnostics),
  "Kitesurf.getSceneStats": commandHandler("Kitesurf.getSceneStats", handlePageDiagnostics),
};
