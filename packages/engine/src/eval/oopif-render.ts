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
  cookieSiteOrigin?: string;
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
  final = false,
): Promise<void> {
  try {
    await warmup;
  } catch {}
  await disposeStub(stub, { unload: final ? "none" : "awaited", reason, killAtOnce: final });
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

export async function prespawnFrameIsolate(
  env: FrameSpawnEnv,
  ctx: ExecutionContext,
  args: RenderFrameArgs,
): Promise<PrespawnedFrame | RenderFrameError> {
  let pageOrigin = "";
  try {
    pageOrigin = new URL(args.frameUrl).origin;
  } catch {
    return { ok: false, error: `unparseable frame URL: ${args.frameUrl}` };
  }
  const docOutbound = args.sandboxOutbound.parent({
    ...localTraceParentProps(),
    pageOrigin,
    cookieSiteOrigin: args.cookieSiteOrigin,
    mainFrameId: args.frameId,
    mainLoaderId: args.frameLoaderId,
    connectionId: args.connectionId,
    cookieKey: args.cookieKey ?? "",
    allowDocumentBypass: true,
    walksOwnRedirects: true,
  });

  let stub: PageScriptStub;
  try {
    stub = spawnFramePageScript(env, ctx, {
      connectionId: args.connectionId,
      targetId: args.targetId,
      frameId: args.frameId,
      frameLoaderId: args.frameLoaderId,
      frameUrl: args.frameUrl,
      cookieKey: args.cookieKey,
      cookieSiteOrigin: args.cookieSiteOrigin,
      attributionHeaders: args.attributionHeaders,
      sandboxOutbound: args.sandboxOutbound,
    });
  } catch (e) {
    return {
      ok: false,
      error: `spawnFramePageScript threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  attachUpstreamHandler(stub, args, args.frameUrl);
  let warmup = prepareFrameIsolate(stub, args);

  let resp: Response;
  let finalUrl: string;
  const walkAbort = new AbortController();
  const walkTimer = setTimeout(
    () => walkAbort.abort(new Error("kitesurf: oopif document walk timeout")),
    OOPIF_DOC_WALK_BUDGET_MS,
  );
  try {
    const secFetchSite =
      args.parentOrigin && args.parentOrigin === pageOrigin ? "same-origin" : "cross-site";
    const walk = await walkRedirects({
      url: args.frameUrl,
      signal: walkAbort.signal,
      fetchHop: (hopReq) => docOutbound.fetch(hopReq),
      headers: {
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
      },
    });
    if (!walk.ok) {
      await discardFrameIsolate(stub, warmup, "oopif doc too many redirects");
      return { ok: false, error: "frame fetch too many redirects" };
    }
    resp = walk.response;
    finalUrl = walk.finalUrl;
  } catch (e) {
    await discardFrameIsolate(stub, warmup, "oopif doc fetch threw");
    return {
      ok: false,
      error: `frame fetch threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    clearTimeout(walkTimer);
  }
  if (!resp.ok) {
    await discardFrameIsolate(stub, warmup, "oopif doc fetch HTTP error");
    return { ok: false, error: `frame fetch HTTP ${resp.status}` };
  }
  let html: string;
  try {
    html = await resp.text();
  } catch (e) {
    await discardFrameIsolate(stub, warmup, "oopif doc body read failed");
    return {
      ok: false,
      error: `frame body read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (originOfFrameUrl(finalUrl) !== pageOrigin) {
    await discardFrameIsolate(stub, warmup, "oopif doc redirected cross-origin");
    try {
      stub = spawnFramePageScript(env, ctx, {
        connectionId: args.connectionId,
        targetId: args.targetId,
        frameId: args.frameId,
        frameLoaderId: args.frameLoaderId,
        frameUrl: finalUrl,
        cookieKey: args.cookieKey,
        cookieSiteOrigin: args.cookieSiteOrigin,
        attributionHeaders: args.attributionHeaders,
        sandboxOutbound: args.sandboxOutbound,
      });
    } catch (e) {
      return {
        ok: false,
        error: `spawnFramePageScript threw: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    attachUpstreamHandler(stub, args, finalUrl);
    warmup = prepareFrameIsolate(stub, args);
  }

  return { ok: true, stub, html, finalUrl, warmup };
}

export async function navigatePrespawnedFrame(
  pre: PrespawnedFrame,
  args: RenderFrameArgs,
): Promise<{ ok: true; stub: PageScriptStub; finalUrl: string } | RenderFrameError> {
  const { stub, html, finalUrl } = pre;
  try {
    await pre.warmup;
    const viewport = frameViewport(args.viewport);
    await stub.navigate(html, finalUrl, {
      connectionId: args.connectionId,
      mainFrameId: args.frameId,
      cookieKey: args.cookieKey ?? "",
      ...(viewport
        ? {
            viewportWidth: viewport.width,
            viewportHeight: viewport.height,
          }
        : {}),
    });
    let loadTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const loadP = stub.awaitLoad().then(() => false);
      const timedOut = await Promise.race([
        loadP,
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

// `final` means nothing reads the frame again, so it is killed without the awaited unload first;
// at socket close that unload would only hold the isolate longer.
export async function discardPrespawnedFrame(
  pre: PrespawnedFrame,
  reason: string,
  final = false,
): Promise<void> {
  await discardFrameIsolate(pre.stub, pre.warmup, reason, final);
}

export async function recordAndRasterizeFrame(
  renderer: PageRendererManager,
  stub: PageScriptStub,
  opts: {
    raster?: Partial<RasterizeOptions>;
    sinceSeq?: number;
    scope?: string;
  } = {},
): Promise<RenderFrameResult | RenderFrameError> {
  const rasterOpts: RasterizeOptions = {
    format: opts.raster?.format ?? "rgba",
    quality: opts.raster?.quality ?? 90,
    omitBackground: opts.raster?.omitBackground ?? false,
  };
  let res: Awaited<ReturnType<PageRendererManager["renderFrame"]>>;
  try {
    res = await renderer.renderFrame(stub, {
      ...rasterOpts,
      ...(typeof opts.sinceSeq === "number" ? { sinceSeq: opts.sinceSeq } : {}),
      ...(opts.scope !== undefined ? { scope: opts.scope } : {}),
    });
  } catch (e) {
    return {
      ok: false,
      error: `child renderFrame threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (res.unchanged === true) {
    return {
      ok: true,
      bytes: new Uint8Array(0),
      seq: typeof res.seq === "number" ? res.seq : undefined,
      finalUrl: "",
      sceneBytes: 0,
    };
  }
  if (!res.ok || !res.bytes) {
    return { ok: false, error: res.error ?? "pageRenderer renderFrame failed" };
  }
  if (rasterOpts.format === "rgba") {
    if (res.bytes.length < RGBA_FRAME_HEADER_BYTES) {
      return { ok: false, error: "rgba envelope too short" };
    }
    const dv = new DataView(res.bytes.buffer, res.bytes.byteOffset, res.bytes.byteLength);
    const w = dv.getUint32(0, true);
    const h = dv.getUint32(4, true);
    const expected = RGBA_FRAME_HEADER_BYTES + w * h * RGBA_BYTES_PER_PIXEL;
    if (res.bytes.length !== expected) {
      return {
        ok: false,
        error: `rgba envelope size mismatch: got ${res.bytes.length}, want ${expected} for ${w}×${h}`,
      };
    }
    return {
      ok: true,
      bytes: res.bytes.subarray(RGBA_FRAME_HEADER_BYTES),
      width: w,
      height: h,
      seq: typeof res.seq === "number" ? res.seq : undefined,
      finalUrl: "",
      sceneBytes: 0,
    };
  }
  return {
    ok: true,
    bytes: res.bytes,
    seq: typeof res.seq === "number" ? res.seq : undefined,
    finalUrl: "",
    sceneBytes: 0,
  };
}
