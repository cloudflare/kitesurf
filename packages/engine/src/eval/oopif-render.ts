// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Handles child-frame document loads and rasterization in separate PageScript isolates.

import type { PageRendererManager } from "./page-renderer.ts";

export interface RasterizeOptions {
  format: string;
  quality: number;
  omitBackground: boolean;
}
import {
  spawnFramePageScript,
  type PageScriptStub,
  type UpstreamEventHandler,
} from "./page-script.ts";
import type { SandboxOutboundOverride } from "./outbound.ts";
import { stubQueryDom } from "../cdp/page-session.ts";
import { disposeStub } from "../cdp/page-script-generation.ts";
import { walkRedirects } from "./redirect-walk.ts";
import { localTraceParentProps } from "../tracing-local.ts";

const OOPIF_DOC_WALK_BUDGET_MS = 15_000;

export interface RenderFrameArgs {
  connectionId: string;
  sandboxOutbound: SandboxOutboundOverride;
  cookieKey?: string;
  targetId: string;
  frameId: string;
  frameLoaderId: string;
  frameUrl: string;
  viewport?: { width: number; height: number };
  parentOrigin?: string;
  onUpstreamEvent?: UpstreamEventHandler;
  makeUpstreamHandler?: (isolate: { stub: PageScriptStub; url: string }) => UpstreamEventHandler;
  raster?: Partial<RasterizeOptions>;
  attributionHeaders?: Record<string, string>;
}

export interface RenderFrameResult {
  ok: true;
  bytes: Uint8Array;
  width?: number;
  height?: number;
  seq?: number;
  finalUrl: string;
  sceneBytes: number;
}

export type RenderFrameError = { ok: false; error: string };

export interface FrameSpawnEnv {
  LOADER: WorkerLoader;
  KITESURF_SIMULATE_PROD_EVAL?: string;
  KITESURF_LAG_WATCHDOG?: string;
}

export interface PrespawnedFrame {
  ok: true;
  stub: PageScriptStub;
  html: string;
  finalUrl: string;
  warmup: Promise<void>;
}

const OOPIF_LOAD_TIMEOUT_MS = 8_000;

function originOfFrameUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function prepareFrameIsolate(stub: PageScriptStub, args: RenderFrameArgs): Promise<void> {
  return (async () => {
    try {
      await stubQueryDom(stub, "setFrameContext", {
        parentOrigin: args.parentOrigin ?? "",
      });
    } catch (e) {
      console.warn(
        `[kitesurf-oopif] setFrameContext failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  })();
}

const MAX_OOPIF_SIDE = 4096;
const MAX_OOPIF_AREA = 7_800_000;
const RGBA_FRAME_HEADER_BYTES = 8;
const RGBA_BYTES_PER_PIXEL = 4;

function frameViewport(
  viewport: { width: number; height: number } | undefined,
): { width: number; height: number } | undefined {
  if (!viewport) return;
  let w = Math.min(MAX_OOPIF_SIDE, Math.max(1, Math.floor(viewport.width)));
  let h = Math.min(MAX_OOPIF_SIDE, Math.max(1, Math.floor(viewport.height)));
  if (w * h > MAX_OOPIF_AREA) {
    const s = Math.sqrt(MAX_OOPIF_AREA / (w * h));
    w = Math.max(1, Math.floor(w * s));
    h = Math.max(1, Math.floor(h * s));
  }
  return { width: w, height: h };
}

async function discardFrameIsolate(
  stub: PageScriptStub,
  warmup: Promise<void>,
  reason: string,
): Promise<void> {
  try {
    await warmup;
  } catch {}
  await disposeStub(stub, { unload: "awaited", reason });
}

function attachUpstreamHandler(
  stub: PageScriptStub,
  args: RenderFrameArgs,
  sealedUrl: string,
): void {
  const handler = args.makeUpstreamHandler
    ? args.makeUpstreamHandler({ stub, url: sealedUrl })
    : args.onUpstreamEvent;
  if (handler) stub.setUpstreamEventHandler?.(handler);
}

export async function spawnAndNavigateFrame(
  env: FrameSpawnEnv,
  ctx: ExecutionContext,
  args: RenderFrameArgs,
): Promise<{ ok: true; stub: PageScriptStub; finalUrl: string } | RenderFrameError> {
  const pre = await prespawnFrameIsolate(env, ctx, args);
  if (!pre.ok) return pre;
  return navigatePrespawnedFrame(pre, args);
}

type SpawnFrameResult = { ok: true; stub: PageScriptStub } | RenderFrameError;

function parseFramePageOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function spawnFrameStub(
  env: FrameSpawnEnv,
  ctx: ExecutionContext,
  args: RenderFrameArgs,
  url: string,
): SpawnFrameResult {
  try {
    return {
      ok: true,
      stub: spawnFramePageScript(env, ctx, {
        connectionId: args.connectionId,
        targetId: args.targetId,
        frameId: args.frameId,
        frameLoaderId: args.frameLoaderId,
        frameUrl: url,
        attributionHeaders: args.attributionHeaders,
        sandboxOutbound: args.sandboxOutbound,
      }),
    };
  } catch (e) {
    return {
      ok: false,
      error: `spawnFramePageScript threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function frameDocumentHeaders(args: RenderFrameArgs, pageOrigin: string): Record<string, string> {
  const secFetchSite =
    args.parentOrigin && args.parentOrigin === pageOrigin ? "same-origin" : "cross-site";
  return {
    "x-kitesurf-resource-type": "Document",
    "x-kitesurf-initiator": "parser",
    "x-kitesurf-allow-cross-origin": "1",
    "x-kitesurf-page-origin": pageOrigin,
    ...(args.connectionId ? { "x-kitesurf-connection-id": args.connectionId } : {}),
    "x-kitesurf-frame-id": args.frameId,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "sec-fetch-dest": "iframe",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": secFetchSite,
    ...(args.parentOrigin ? { referer: args.parentOrigin + "/" } : {}),
  };
}

type FrameResponseResult =
  | { ok: true; response: Response; finalUrl: string }
  | { ok: false; error: string; reason: string };

async function requestFrameDocument(
  docOutbound: Fetcher,
  args: RenderFrameArgs,
  pageOrigin: string,
): Promise<FrameResponseResult> {
  const walkAbort = new AbortController();
  const walkTimer = setTimeout(
    () => walkAbort.abort(new Error("kitesurf: oopif document walk timeout")),
    OOPIF_DOC_WALK_BUDGET_MS,
  );
  try {
    const walk = await walkRedirects({
      url: args.frameUrl,
      signal: walkAbort.signal,
      fetchHop: (hopReq) => docOutbound.fetch(hopReq),
      headers: frameDocumentHeaders(args, pageOrigin),
    });
    if (!walk.ok) {
      return {
        ok: false,
        error: "frame fetch too many redirects",
        reason: "oopif doc too many redirects",
      };
    }
    return { ok: true, response: walk.response, finalUrl: walk.finalUrl };
  } catch (e) {
    return {
      ok: false,
      error: `frame fetch threw: ${e instanceof Error ? e.message : String(e)}`,
      reason: "oopif doc fetch threw",
    };
  } finally {
    clearTimeout(walkTimer);
  }
}

type FrameBodyResult = { ok: true; html: string } | RenderFrameError;

async function readFrameBody(response: Response): Promise<FrameBodyResult> {
  if (!response.ok) return { ok: false, error: `frame fetch HTTP ${response.status}` };
  try {
    return { ok: true, html: await response.text() };
  } catch (e) {
    return {
      ok: false,
      error: `frame body read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

async function fetchFrameDocument(
  docOutbound: Fetcher,
  args: RenderFrameArgs,
  pageOrigin: string,
  isolate: { stub: PageScriptStub; warmup: Promise<void> },
): Promise<{ ok: true; html: string; finalUrl: string } | RenderFrameError> {
  const fetched = await requestFrameDocument(docOutbound, args, pageOrigin);
  if (!fetched.ok) {
    await discardFrameIsolate(isolate.stub, isolate.warmup, fetched.reason);
    return { ok: false, error: fetched.error };
  }
  const body = await readFrameBody(fetched.response);
  if (!body.ok) {
    const reason = fetched.response.ok
      ? "oopif doc body read failed"
      : "oopif doc fetch HTTP error";
    await discardFrameIsolate(isolate.stub, isolate.warmup, reason);
    return body;
  }
  return { ok: true, html: body.html, finalUrl: fetched.finalUrl };
}

interface FrameIsolate {
  stub: PageScriptStub;
  warmup: Promise<void>;
}

async function replaceCrossOriginFrame(
  env: FrameSpawnEnv,
  ctx: ExecutionContext,
  args: RenderFrameArgs,
  pageOrigin: string,
  finalUrl: string,
  isolate: FrameIsolate,
): Promise<FrameIsolate | RenderFrameError> {
  if (originOfFrameUrl(finalUrl) === pageOrigin) return isolate;
  await discardFrameIsolate(isolate.stub, isolate.warmup, "oopif doc redirected cross-origin");
  const replacement = spawnFrameStub(env, ctx, args, finalUrl);
  if (!replacement.ok) return replacement;
  attachUpstreamHandler(replacement.stub, args, finalUrl);
  return {
    stub: replacement.stub,
    warmup: prepareFrameIsolate(replacement.stub, args),
  };
}

async function prespawnAtPageOrigin(
  env: FrameSpawnEnv,
  ctx: ExecutionContext,
  args: RenderFrameArgs,
  pageOrigin: string,
  docOutbound: Fetcher,
): Promise<PrespawnedFrame | RenderFrameError> {
  const spawned = spawnFrameStub(env, ctx, args, args.frameUrl);
  if (!spawned.ok) return spawned;
  attachUpstreamHandler(spawned.stub, args, args.frameUrl);
  const initial = { stub: spawned.stub, warmup: prepareFrameIsolate(spawned.stub, args) };
  const fetched = await fetchFrameDocument(docOutbound, args, pageOrigin, initial);
  if (!fetched.ok) return fetched;
  const isolate = await replaceCrossOriginFrame(
    env,
    ctx,
    args,
    pageOrigin,
    fetched.finalUrl,
    initial,
  );
  if ("error" in isolate) return isolate;
  return {
    ok: true,
    stub: isolate.stub,
    html: fetched.html,
    finalUrl: fetched.finalUrl,
    warmup: isolate.warmup,
  };
}

export async function prespawnFrameIsolate(
  env: FrameSpawnEnv,
  ctx: ExecutionContext,
  args: RenderFrameArgs,
): Promise<PrespawnedFrame | RenderFrameError> {
  const pageOrigin = parseFramePageOrigin(args.frameUrl);
  if (pageOrigin === null) return { ok: false, error: `unparseable frame URL: ${args.frameUrl}` };
  const docOutbound = args.sandboxOutbound.parent({
    ...localTraceParentProps(),
    pageOrigin,
    mainFrameId: args.frameId,
    mainLoaderId: args.frameLoaderId,
    connectionId: args.connectionId,
    cookieKey: args.cookieKey ?? "",
    allowDocumentBypass: true,
    walksOwnRedirects: true,
  });
  return prespawnAtPageOrigin(env, ctx, args, pageOrigin, docOutbound);
}

export async function navigatePrespawnedFrame(
  pre: PrespawnedFrame,
  args: RenderFrameArgs,
): Promise<{ ok: true; stub: PageScriptStub; finalUrl: string } | RenderFrameError> {
  const { stub, html, finalUrl } = pre;
  try {
    await pre.warmup;
    await stub.navigate(html, finalUrl, frameNavigationOptions(args));
    await waitForFrameLoad(stub, finalUrl);
  } catch (e) {
    await disposeStub(stub, {
      unload: "awaited",
      reason: "oopif spawn failed",
    });
    return {
      ok: false,
      error: `child navigate/awaitLoad threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return { ok: true, stub, finalUrl };
}

function frameNavigationOptions(args: RenderFrameArgs) {
  const viewport = frameViewport(args.viewport);
  return {
    connectionId: args.connectionId,
    mainFrameId: args.frameId,
    cookieKey: args.cookieKey ?? "",
    ...(viewport
      ? {
          viewportWidth: viewport.width,
          viewportHeight: viewport.height,
        }
      : {}),
  };
}

async function waitForFrameLoad(stub: PageScriptStub, finalUrl: string): Promise<void> {
  let loadTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const load = stub.awaitLoad().then(() => false);
    const timedOut = await Promise.race([
      load,
      new Promise<boolean>((resolve) => {
        loadTimer = setTimeout(() => resolve(true), OOPIF_LOAD_TIMEOUT_MS);
      }),
    ]);
    if (timedOut) {
      console.warn(
        `[kitesurf-oopif] load timed out after ${OOPIF_LOAD_TIMEOUT_MS}ms, ` +
          `painting what it has: ${finalUrl}`,
      );
    }
  } finally {
    if (loadTimer !== null) clearTimeout(loadTimer);
  }
}

export async function discardPrespawnedFrame(pre: PrespawnedFrame, reason: string): Promise<void> {
  await discardFrameIsolate(pre.stub, pre.warmup, reason);
}

export async function recordAndRasterizeFrame(
  renderer: PageRendererManager,
  stub: PageScriptStub,
  opts: {
    raster?: Partial<RasterizeOptions>;
    sinceSeq?: number;
  } = {},
): Promise<RenderFrameResult | RenderFrameError> {
  const raster = frameRasterOptions(opts.raster);
  const call = await requestFrameRender(renderer, stub, raster, opts.sinceSeq);
  return frameRenderResult(call, raster.format);
}

function frameRasterOptions(options: Partial<RasterizeOptions> | undefined): RasterizeOptions {
  return {
    format: requestedFormat(options),
    quality: requestedQuality(options),
    omitBackground: requestedBackgroundMode(options),
  };
}

function requestedFormat(options: Partial<RasterizeOptions> | undefined): string {
  return options?.format ?? "rgba";
}

function requestedQuality(options: Partial<RasterizeOptions> | undefined): number {
  return options?.quality ?? 90;
}

function requestedBackgroundMode(options: Partial<RasterizeOptions> | undefined): boolean {
  return options?.omitBackground ?? false;
}

function frameRenderResult(
  call: FrameRenderCall,
  format: string,
): RenderFrameResult | RenderFrameError {
  if (!call.ok) return call;
  const res = call.result;
  if (res.unchanged === true) {
    return unchangedFrameResult(res);
  }
  return renderableFrameResult(res, format);
}

function renderableFrameResult(
  reply: FrameRenderReply,
  format: string,
): RenderFrameResult | RenderFrameError {
  if (!hasRenderableFrameBytes(reply)) {
    return { ok: false, error: reply.error ?? "pageRenderer renderFrame failed" };
  }
  return format === "rgba" ? rgbaFrameResult(reply) : encodedFrameResult(reply);
}

type FrameRenderReply = Awaited<ReturnType<PageRendererManager["renderFrame"]>>;
type FrameRenderCall = { ok: true; result: FrameRenderReply } | RenderFrameError;

async function requestFrameRender(
  renderer: PageRendererManager,
  stub: PageScriptStub,
  raster: RasterizeOptions,
  sinceSeq: number | undefined,
): Promise<FrameRenderCall> {
  try {
    const result = await renderer.renderFrame(stub, {
      ...raster,
      ...(typeof sinceSeq === "number" ? { sinceSeq } : {}),
    });
    return { ok: true, result };
  } catch (e) {
    return {
      ok: false,
      error: `child renderFrame threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

function frameSequence(reply: FrameRenderReply): number | undefined {
  return typeof reply.seq === "number" ? reply.seq : undefined;
}

function unchangedFrameResult(reply: FrameRenderReply): RenderFrameResult {
  return {
    ok: true,
    bytes: new Uint8Array(0),
    seq: frameSequence(reply),
    finalUrl: "",
    sceneBytes: 0,
  };
}

function hasRenderableFrameBytes(
  reply: FrameRenderReply,
): reply is FrameRenderReply & { bytes: Uint8Array } {
  return reply.ok && reply.bytes !== undefined;
}

function encodedFrameResult(reply: FrameRenderReply & { bytes: Uint8Array }): RenderFrameResult {
  return {
    ok: true,
    bytes: reply.bytes,
    seq: frameSequence(reply),
    finalUrl: "",
    sceneBytes: 0,
  };
}

function rgbaFrameResult(
  reply: FrameRenderReply & { bytes: Uint8Array },
): RenderFrameResult | RenderFrameError {
  const bytes = reply.bytes;
  if (bytes.length < RGBA_FRAME_HEADER_BYTES)
    return { ok: false, error: "rgba envelope too short" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const expectedLength = RGBA_FRAME_HEADER_BYTES + width * height * RGBA_BYTES_PER_PIXEL;
  if (bytes.length !== expectedLength) {
    return {
      ok: false,
      error: `rgba envelope size mismatch: got ${bytes.length}, want ${expectedLength} for ${width}×${height}`,
    };
  }
  return {
    ok: true,
    bytes: bytes.subarray(RGBA_FRAME_HEADER_BYTES),
    width,
    height,
    seq: frameSequence(reply),
    finalUrl: "",
    sceneBytes: 0,
  };
}
