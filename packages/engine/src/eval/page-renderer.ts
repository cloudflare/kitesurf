// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Loads the renderer isolate and serializes frame and PDF rendering calls.

import rendererGlueSource from "../../../renderer-core/pkg/renderer_core.glue.js";
import rendererWasmModule from "../../../renderer-core/pkg/renderer_core_bg.wasm";
import { PAGE_RENDERER_SOURCE } from "@kitesurf/page-renderer";
import { loadWasmBytesFromVfs } from "./page-script.ts";
import { traceSpan } from "../tracing.ts";
import { localTraceParentProps } from "../tracing-local.ts";
import { attributionTails, type AttributionTailExports } from "./attribution-tail.ts";
import { getFontBytes, getImageBytes } from "./resource-store.ts";
import type { Tracer } from "../tracing.ts";
import type {
  PageRendererEntrypoint,
  RenderFrameOpts,
  RenderPdfOpts,
  RenderPortStub,
  RenderStage,
} from "@kitesurf/jsrpc-types/page-renderer";
import type { DynamicWorkerBudget, WorkerLease } from "./worker-budget.ts";

export type { RenderStage };

void rendererWasmModule;

const PAGE_RENDERER_COMPAT_DATE = "2026-09-11";

const PAGE_RENDERER_SUBREQUEST_CAP = 100;
const PAGE_RENDERER_CPU_TIME_MS_CAP = 300_000;

const RENDER_CALL_TIMEOUT_MS = 15_000;
const PDF_CALL_TIMEOUT_MS = 30_000;
const PORT_MINT_TIMEOUT_MS = 5_000;
const MAX_RENDER_RASTER_ATTEMPTS = 2;

type CtxWithExports = ExecutionContext & {
  exports: AttributionTailExports & {
    DeniedOutbound(opts: Record<string, never>): Fetcher;
    PageScriptTail(opts: {
      props: { scriptName: string; ksErrToken?: string; sessionId?: string };
    }): Fetcher;
    SpanSink(opts: { props: { kind: string } }): unknown;
  };
};

export interface RendererEnv {
  LOADER: WorkerLoader;
  FONT_ASSETS: Fetcher;
  HOST_TRACER?: Tracer;
}

type RendererStub = Fetcher<PageRendererEntrypoint>;

class RendererTimeoutError extends Error {}

function disposeRenderer(stub: RendererStub | null, reason: string): void {
  if (!stub || typeof stub.killIsolate !== "function") return;
  try {
    Promise.resolve(stub.killIsolate(reason)).catch(() => {});
  } catch {}
}

type RenderFrameReply = Awaited<ReturnType<PageRendererEntrypoint["renderFrame"]>>;
type RenderPdfReply = Awaited<ReturnType<PageRendererEntrypoint["renderPdf"]>>;

function isPartialFrame(phases: string[] | undefined): boolean {
  return (
    Array.isArray(phases) &&
    phases.some((phase) => typeof phase === "string" && phase.startsWith("rasterPartial="))
  );
}

function hasRenderFrameError(reply: RenderFrameReply): boolean {
  return Boolean(reply.error || !(reply.bytes instanceof Uint8Array) || reply.bytes.length === 0);
}

function frameErrorResult(
  reply: RenderFrameReply,
  seq: number,
  scrollX: number,
  scrollY: number,
): RenderFrameResult {
  return {
    ok: false,
    stage: reply.stage ?? "raster",
    error: reply.error ?? "renderer returned empty bytes",
    info: reply.info,
    seq,
    scrollX,
    scrollY,
  };
}

function frameReplyResult(reply: RenderFrameReply): RenderFrameResult {
  const { seq, scrollX, scrollY } = framePosition(reply);
  if (reply.unchanged === true) return { ok: true, unchanged: true, seq, scrollX, scrollY };
  if (hasRenderFrameError(reply)) return frameErrorResult(reply, seq, scrollX, scrollY);
  return { ok: true, bytes: reply.bytes, info: reply.info, seq, scrollX, scrollY };
}

function framePosition(reply: RenderFrameReply): {
  seq: number;
  scrollX: number;
  scrollY: number;
} {
  return {
    seq: typeof reply.seq === "number" ? reply.seq : 0,
    scrollX: typeof reply.scrollX === "number" ? reply.scrollX : 0,
    scrollY: typeof reply.scrollY === "number" ? reply.scrollY : 0,
  };
}

function hasRenderPdfError(reply: RenderPdfReply): boolean {
  return Boolean(reply.error || !(reply.bytes instanceof Uint8Array) || reply.bytes.length === 0);
}

function pdfErrorResult(reply: RenderPdfReply): RenderPdfResult {
  return {
    ok: false,
    stage: reply.stage ?? "raster",
    error: reply.error ?? "renderer returned empty bytes",
    info: reply.info,
  };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new RendererTimeoutError(`${label}: timeout after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function loadRenderer(
  env: RendererEnv,
  ctx: ExecutionContext,
  connectionId: string,
  attributionHeaders: Record<string, string>,
  initialRes: { width: number; height: number } | null,
): RendererStub {
  // SAFETY: Embedding hosts may add `AttributionTail` to this WorkerLoader context;
  // generated ExecutionContext types include only the public engine's exports.
  // Verified by: packages/engine/test/e2e/renderer-laziness.e2e.test.ts.
  const contextWithExports = ctx as CtxWithExports;
  const tailToken = crypto.randomUUID();
  const stub = env.LOADER.load({
    compatibilityDate: PAGE_RENDERER_COMPAT_DATE,
    compatibilityFlags: ["no_nodejs_compat", "no_nodejs_compat_v2"],
    mainModule: "renderer.js",
    modules: {
      "renderer.js": PAGE_RENDERER_SOURCE,
      "wasm-glue.js": rendererGlueSource,
      "core_bg.wasm": { wasm: loadWasmBytesFromVfs("renderer_core_bg.wasm") },
    },
    env: {
      KS_TAIL_TOKEN: tailToken,
      ...(initialRes ? { KS_INITIAL_RES: `${initialRes.width}x${initialRes.height}` } : {}),
      ...(env.HOST_TRACER
        ? {
            KS_SPAN_SINK: contextWithExports.exports.SpanSink({
              props: { kind: "renderer", ...localTraceParentProps() },
            }),
          }
        : {}),
    },
    // Resources arrive through engine callbacks; the renderer has no outbound network path.
    globalOutbound: contextWithExports.exports.DeniedOutbound({}),
    tails: [
      contextWithExports.exports.PageScriptTail({
        props: {
          scriptName: `renderer-${connectionId}`,
          ksErrToken: tailToken,
          sessionId: connectionId,
        },
      }),
      ...attributionTails(contextWithExports.exports, attributionHeaders, "kitesurf-page-renderer"),
    ],
    limits: {
      cpuMs: PAGE_RENDERER_CPU_TIME_MS_CAP,
      subRequests: PAGE_RENDERER_SUBREQUEST_CAP,
    },
  });
  return stub.getEntrypoint<PageRendererEntrypoint>("PageRenderer");
}

export interface RenderPortSource {
  getRenderPort(): Promise<RenderPortStub>;
}

export type RenderFrameOptions = Omit<RenderFrameOpts, "tp">;

export interface RenderFrameResult {
  ok: boolean;
  unchanged?: boolean;
  bytes?: Uint8Array;
  error?: string;
  stage?: RenderStage;
  info?: string;
  seq: number;
  scrollX: number;
  scrollY: number;
}

export type RenderPdfOptions = Omit<RenderPdfOpts, "tp">;

export interface RenderPdfResult {
  ok: boolean;
  bytes?: Uint8Array;
  error?: string;
  stage?: RenderStage;
  info?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRenderRasterFailure(result: RenderFrameResult | RenderPdfResult): boolean {
  return !result.ok && result.stage === "raster";
}

function rasterFailureError(result: RenderFrameResult | RenderPdfResult, fallback: string): Error {
  return new Error(result.error ?? fallback);
}

function frameTimingOptions(opts: RenderFrameOptions): Partial<RenderFrameOpts> {
  return {
    ...(typeof opts.sinceSeq === "number" ? { sinceSeq: opts.sinceSeq } : {}),
    ...(opts.clip ? { clip: opts.clip } : {}),
    ...(typeof opts.partialKey === "string" && opts.partialKey
      ? { partialKey: opts.partialKey }
      : {}),
  };
}

function frameResourceOptions(opts: RenderFrameOptions): Partial<RenderFrameOpts> {
  return {
    ...(opts.images ? { images: opts.images } : {}),
    ...(opts.traced ? { traced: true } : {}),
  };
}

function traceParentOptions(traceParentId: string | null): { tp?: string } {
  return traceParentId ? { tp: traceParentId } : {};
}

function pdfRenderOptions(opts: RenderPdfOptions, traceParentId: string | null): RenderPdfOpts {
  return {
    paperWidth: opts.paperWidth,
    paperHeight: opts.paperHeight,
    omitBackground: opts.omitBackground,
    marginTop: opts.marginTop,
    marginRight: opts.marginRight,
    marginBottom: opts.marginBottom,
    marginLeft: opts.marginLeft,
    ...(opts.traced ? { traced: true } : {}),
    ...(traceParentId ? { tp: traceParentId } : {}),
  };
}

function frameRecordError(error: unknown): RenderFrameResult {
  return {
    ok: false,
    stage: "record",
    error: `getRenderPort failed: ${errorMessage(error)}`,
    seq: 0,
    scrollX: 0,
    scrollY: 0,
  };
}

function pdfRecordError(error: unknown): RenderPdfResult {
  return {
    ok: false,
    stage: "record",
    error: `getRenderPort failed: ${errorMessage(error)}`,
  };
}

export class PageRendererManager {
  private env: RendererEnv;
  private ctx: ExecutionContext;
  private connectionId: string;
  private attributionHeaders: Record<string, string>;
  private stub: RendererStub | null = null;
  private everLoaded = false;
  private initialRes: { width: number; height: number } | null = null;
  private lease: WorkerLease | null = null;
  private budget: DynamicWorkerBudget | null = null;
  relaunchCount = 0;
  framesRendered = 0;
  partialFramesRendered = 0;
  // Render RPCs mutate one retained partial-frame base, so keep them ordered.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    env: RendererEnv,
    ctx: ExecutionContext,
    connectionId: string,
    attributionHeaders: Record<string, string> = {},
    budget: DynamicWorkerBudget | null = null,
    initialRes: { width: number; height: number } | null = null,
  ) {
    this.env = env;
    this.ctx = ctx;
    this.connectionId = connectionId;
    this.attributionHeaders = attributionHeaders;
    this.budget = budget;
    this.initialRes = initialRes;
  }

  private ensure(): RendererStub {
    if (!this.stub) {
      if (this.everLoaded) this.relaunchCount += 1;
      this.everLoaded = true;
      this.lease = this.budget?.acquire("renderer") ?? null;
      this.stub = traceSpan(this.env.HOST_TRACER, "init.renderer_spawn", () =>
        loadRenderer(
          this.env,
          this.ctx,
          this.connectionId,
          this.attributionHeaders,
          this.initialRes,
        ),
      );
    }
    return this.stub;
  }

  private traceParentId(): string | null {
    return this.env.HOST_TRACER?.getSpanContext()?.spanId ?? null;
  }

  private fetchStoredImage(key: string): Uint8Array {
    let parsed: bigint;
    try {
      parsed = BigInt(key);
    } catch {
      return new Uint8Array(0);
    }
    return getImageBytes(parsed, this.connectionId) ?? new Uint8Array(0);
  }

  private fetchStoredFont(key: string): Uint8Array {
    let parsed: bigint;
    try {
      parsed = BigInt(key);
    } catch {
      return new Uint8Array(0);
    }
    return getFontBytes(parsed, this.connectionId) ?? new Uint8Array(0);
  }

  private async fetchFontAsset(path: string): Promise<Uint8Array> {
    if (!path.startsWith("/fonts/") || path.includes("..")) {
      throw new Error(`fetchFontAsset: refusing path ${path}`);
    }
    const resp = await this.env.FONT_ASSETS.fetch(
      new Request(`https://kitesurf.invalid${path}`, { method: "GET" }),
    );
    if (!resp.ok) {
      throw new Error(`fetchFontAsset: HTTP ${resp.status} for ${path}`);
    }
    return new Uint8Array(await resp.arrayBuffer());
  }

  async memoryStats(): Promise<{
    bytes: number;
    initialBytes: number;
    deltaBytes: number;
  } | null> {
    if (!this.stub) return null;
    try {
      return await withTimeout(this.stub.memoryStats(), 5_000, "memoryStats");
    } catch {
      return null;
    }
  }

  initialResString(): string | null {
    return this.initialRes ? `${this.initialRes.width}x${this.initialRes.height}` : null;
  }

  /** Releases the worker lease and requests isolate shutdown without waiting for completion. */
  dispose(reason = "renderer disposed"): void {
    const stub = this.stub;
    this.stub = null;
    this.lease?.release();
    this.lease = null;
    disposeRenderer(stub, reason);
  }

  /**
   * Serializes frame renders so calls cannot mutate the retained partial-frame base concurrently.
   * Worker and timeout failures resolve as `ok: false`; timed-out workers are discarded.
   */
  async renderFrame(
    source: RenderPortSource,
    opts: RenderFrameOptions,
  ): Promise<RenderFrameResult> {
    const run = this.queue.catch(() => {}).then(() => this.renderFrameWithRetry(source, opts));
    this.queue = run;
    return run;
  }

  private async renderFrameWithRetry(
    source: RenderPortSource,
    opts: RenderFrameOptions,
  ): Promise<RenderFrameResult> {
    let lastError = "";
    for (let attempt = 0; attempt < MAX_RENDER_RASTER_ATTEMPTS; attempt++) {
      try {
        const result = await this.renderFrameOnce(source, opts);
        if (!isRenderRasterFailure(result)) return result;
        throw rasterFailureError(result, "renderFrame raster failure");
      } catch (error) {
        lastError = errorMessage(error);
        this.dispose(`renderFrame failed: ${lastError}`);
        // A timed-out RPC may still be running, so do not retry against this renderer.
        if (error instanceof RendererTimeoutError) break;
      }
    }
    return { ok: false, error: lastError, seq: 0, scrollX: 0, scrollY: 0 };
  }

  private async renderFrameOnce(
    source: RenderPortSource,
    opts: RenderFrameOptions,
  ): Promise<RenderFrameResult> {
    const stub = this.ensure();
    const traceParentId = this.traceParentId();
    let port: RenderPortStub;
    try {
      port = await withTimeout(source.getRenderPort(), PORT_MINT_TIMEOUT_MS, "getRenderPort");
    } catch (error) {
      return frameRecordError(error);
    }
    const reply = await withTimeout(
      stub.renderFrame(
        port,
        {
          format: opts.format,
          quality: opts.quality,
          omitBackground: opts.omitBackground,
          ...frameTimingOptions(opts),
          ...frameResourceOptions(opts),
          ...traceParentOptions(traceParentId),
        },
        (path: string) => this.fetchFontAsset(path),
        async (key: string) => this.fetchStoredImage(key),
        async (key: string) => this.fetchStoredFont(key),
      ),
      RENDER_CALL_TIMEOUT_MS,
      "renderFrame",
    );
    if (reply.unchanged === true) return frameReplyResult(reply);
    this.logSlowPhases("renderFrame", reply.phases);
    const result = frameReplyResult(reply);
    if (!result.ok) return result;
    this.framesRendered += 1;
    if (isPartialFrame(reply.phases)) {
      this.partialFramesRendered += 1;
    }
    return result;
  }

  /** Queues PDF rendering on the shared renderer worker; worker failures resolve as `ok: false`. */
  async renderPdf(source: RenderPortSource, opts: RenderPdfOptions): Promise<RenderPdfResult> {
    const run = this.queue.catch(() => {}).then(() => this.renderPdfWithRetry(source, opts));
    this.queue = run;
    return run;
  }

  private async renderPdfWithRetry(
    source: RenderPortSource,
    opts: RenderPdfOptions,
  ): Promise<RenderPdfResult> {
    let lastError = "";
    for (let attempt = 0; attempt < MAX_RENDER_RASTER_ATTEMPTS; attempt++) {
      try {
        const result = await this.renderPdfOnce(source, opts);
        if (!isRenderRasterFailure(result)) return result;
        throw rasterFailureError(result, "renderPdf raster failure");
      } catch (error) {
        lastError = errorMessage(error);
        this.dispose(`renderPdf failed: ${lastError}`);
        if (error instanceof RendererTimeoutError) break;
      }
    }
    return { ok: false, error: lastError };
  }

  private async renderPdfOnce(
    source: RenderPortSource,
    opts: RenderPdfOptions,
  ): Promise<RenderPdfResult> {
    const stub = this.ensure();
    const traceParentId = this.traceParentId();
    let port: RenderPortStub;
    try {
      port = await withTimeout(source.getRenderPort(), PORT_MINT_TIMEOUT_MS, "getRenderPort");
    } catch (error) {
      return pdfRecordError(error);
    }
    const reply = await withTimeout(
      stub.renderPdf(
        port,
        pdfRenderOptions(opts, traceParentId),
        (path: string) => this.fetchFontAsset(path),
        async (key: string) => this.fetchStoredImage(key),
        async (key: string) => this.fetchStoredFont(key),
      ),
      PDF_CALL_TIMEOUT_MS,
      "renderPdf",
    );
    this.logSlowPhases("renderPdf", reply.phases);
    if (hasRenderPdfError(reply)) return pdfErrorResult(reply);
    this.framesRendered += 1;
    return { ok: true, bytes: reply.bytes, info: reply.info };
  }

  private logSlowPhases(method: string, phases?: string[]): void {
    if (!Array.isArray(phases)) return;
    const totalMs = phases
      .map((phase) => Number(phase.split("=")[1]?.replace("ms", "")) || 0)
      .reduce((sumMs, phaseMs) => sumMs + phaseMs, 0);
    if (totalMs > 1_000) {
      console.warn(`[ks-rvr] ${method} phases: ${phases.join(" ")}`);
    }
  }
}
