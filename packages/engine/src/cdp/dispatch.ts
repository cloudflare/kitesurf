// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Routes CDP commands to target sessions, domain handlers, and host extensions.

import type { BrowserState, CdpRequest, CdpResponse, EventEmitter, TargetState } from "./types.ts";
import type { RequestBlocker } from "../request-blocker.ts";
import { CDP_COMMAND_UNHANDLED } from "./types.ts";
import {
  handleTarget,
  handleRendererSession,
  handleEngineSession,
  handleOopifSession,
  findOopifFrameBySession,
} from "./target.ts";
import { handlePage } from "./page.ts";
import { handleRuntime } from "./runtime.ts";
import { handleDom } from "./dom.ts";
import { handleNetwork } from "./network.ts";
import { handleFetch } from "./fetch.ts";
import { handleInput } from "./input.ts";
import { handleKitesurf } from "./kitesurf.ts";
import { handleWebMcp } from "./webmcp.ts";
import { handleDebugger } from "./debugger.ts";
import { handleCss } from "./css.ts";
import { handleAccessibility } from "./accessibility.ts";
import { sessionOf } from "./page-session.ts";
import { clampViewport } from "./viewport.ts";
import type { KitesurfAnalytics } from "../observability.ts";
import type { Tracer } from "../tracing.ts";
import type { HostClock } from "../eval/host-clock.ts";

export interface EngineCdpCommandRequest {
  id: number;
  method: string;
  params?: unknown;
  sessionId?: string;
}

export type EngineCdpCommandResult = { handled: true; result: unknown } | { handled: false };

export type EngineCdpCommandExtension = (
  ctx: DispatchCtx,
  req: EngineCdpCommandRequest,
) => Promise<EngineCdpCommandResult>;

export interface DispatchCtx {
  browser: BrowserState;
  emit: EventEmitter;
  commandExtension?: EngineCdpCommandExtension;
  /** Host request blocker for this connection; also registered for SandboxOutbound. */
  requestBlocker?: RequestBlocker;
  env: {
    LOADER: WorkerLoader;
    FONT_ASSETS: Fetcher;
    KITESURF_SIMULATE_PROD_EVAL?: string;
    KITESURF_RESOURCE_DRAIN_QUIET_TURNS?: string;
    KITESURF_LAG_WATCHDOG?: string;
    // Per-page-isolate deployment budgets: CPU cap on LOADER.load,
    // wall-clock kill timer per generation. See eval/page-script.ts.
    KITESURF_PAGE_CPU_MS_CAP?: string;
    KITESURF_PAGE_WALL_MS_CAP?: string;
    HOST_TRACER?: Tracer;
    HOST_CLOCK?: HostClock;
  };
  ctx: ExecutionContext;
  connectionId: string;
  analytics: KitesurfAnalytics;
}

export async function dispatch(ctx: DispatchCtx, req: CdpRequest): Promise<CdpResponse> {
  const [domain] = req.method.split(".", 1);

  ctx.browser.networkEvents.drain();

  try {
    return await dispatchRequest(ctx, req, domain);
  } catch (err) {
    ctx.browser.networkEvents.drain();
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: req.id,
      error: { code: -32000, message },
      sessionId: req.sessionId,
    };
  }
}

async function dispatchRequest(
  ctx: DispatchCtx,
  req: CdpRequest,
  domain: string | undefined,
): Promise<CdpResponse> {
  const early = await earlyResponse(ctx, req);
  if (early) return early;
  const routed = await dispatchDomain(ctx, req, domain);
  if (!routed.handled) {
    ctx.browser.networkEvents.drain();
    return methodNotFound(req);
  }
  return domainResponse(ctx, req, routed.result);
}

async function earlyResponse(ctx: DispatchCtx, req: CdpRequest): Promise<CdpResponse | null> {
  const version = browserVersionResponse(req);
  if (version) return version;
  return attachedSessionResponse(ctx, req);
}

function domainResponse(ctx: DispatchCtx, req: CdpRequest, result: unknown): CdpResponse {
  ctx.browser.networkEvents.drain();
  return { id: req.id, result: result ?? {}, sessionId: req.sessionId };
}

function browserVersionResponse(req: CdpRequest): CdpResponse | null {
  if (req.method !== "Browser.getVersion") return null;
  return {
    id: req.id,
    result: {
      protocolVersion: "1.3",
      product: "Chrome/145.0.0.0",
      revision: "@kitesurf",
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      jsVersion: "12.0.0",
    },
    sessionId: req.sessionId,
  };
}

async function attachedSessionResponse(
  ctx: DispatchCtx,
  req: CdpRequest,
): Promise<CdpResponse | null> {
  const renderer = await rendererSessionResponse(ctx, req);
  if (renderer) return renderer;
  const engine = await engineSessionResponse(ctx, req);
  if (engine) return engine;
  return oopifSessionResponse(ctx, req);
}

async function rendererSessionResponse(
  ctx: DispatchCtx,
  req: CdpRequest,
): Promise<CdpResponse | null> {
  if (!req.sessionId || req.sessionId !== ctx.browser.rendererSessionId) return null;
  const result = await handleRendererSession(ctx, req);
  return drainedSessionResponse(ctx, req, result);
}

async function engineSessionResponse(
  ctx: DispatchCtx,
  req: CdpRequest,
): Promise<CdpResponse | null> {
  if (!req.sessionId || req.sessionId !== ctx.browser.engineSessionId) return null;
  const result = await handleEngineSession(ctx, req);
  return drainedSessionResponse(ctx, req, result);
}

async function oopifSessionResponse(
  ctx: DispatchCtx,
  req: CdpRequest,
): Promise<CdpResponse | null> {
  if (!req.sessionId) return null;
  const oopif = findOopifFrameBySession(ctx, req.sessionId);
  if (!oopif) return null;
  const result = await handleOopifSession(ctx, req, oopif.target, oopif.frame);
  return drainedSessionResponse(ctx, req, result);
}

function drainedSessionResponse(ctx: DispatchCtx, req: CdpRequest, result: unknown): CdpResponse {
  ctx.browser.networkEvents.drain();
  return { id: req.id, result: result ?? {}, sessionId: req.sessionId };
}

type DomainDispatchResult = { handled: true; result: unknown } | { handled: false };

async function dispatchDomain(
  ctx: DispatchCtx,
  req: CdpRequest,
  domain: string | undefined,
): Promise<DomainDispatchResult> {
  switch (domain) {
    case "Target":
      return handled(await handleTarget(ctx, req));
    case "Page":
      return handled(await handlePage(ctx, req));
    case "Runtime":
      return handled(await handleRuntime(ctx, req));
    case "DOM":
      return handled(await handleDom(ctx, req));
    case "Network":
    case "Storage":
      return handled(await handleNetwork(ctx, req));
    case "Fetch":
      return handled(await handleFetch(ctx, req));
    case "Input":
      return handled(await handleInput(ctx, req));
    case "Kitesurf":
      return dispatchKitesurf(ctx, req);
    case "WebMCP":
      return handled(await handleWebMcp(ctx, req));
    case "Debugger":
      return handled(await handleDebugger(ctx, req));
    case "CSS":
      return handled(await handleCss(ctx, req));
    case "Accessibility":
      return handled(await handleAccessibility(ctx, req));
    case "Emulation":
      return handled(await handleEmulation(ctx, req));
    // These domains remain unsupported; clients probe them during attach.
    case "Animation":
    case "Audits":
    case "Autofill":
    case "BackgroundService":
    case "Browser":
    case "Cast":
    case "Console":
    case "Database":
    case "DeviceOrientation":
    case "DOMDebugger":
    case "DOMSnapshot":
    case "DOMStorage":
    case "FedCm":
    case "Headless":
    case "HeapProfiler":
    case "IndexedDB":
    case "Inspector":
    case "IO":
    case "LayerTree":
    case "Log":
    case "Media":
    case "Memory":
    case "Overlay":
    case "Page-CSP":
    case "Performance":
    case "PerformanceTimeline":
    case "Preload":
    case "Profiler":
    case "Schema":
    case "Security":
    case "ServiceWorker":
    case "Tethering":
    case "Tracing":
    case "WebAudio":
    case "WebAuthn":
      return handled({});
    default:
      return { handled: false };
  }
}

async function dispatchKitesurf(ctx: DispatchCtx, req: CdpRequest): Promise<DomainDispatchResult> {
  const result = await handleKitesurf(ctx, req);
  if (result !== CDP_COMMAND_UNHANDLED) return handled(result);
  // Public handlers win; the host only sees commands they decline.
  const extension = ctx.commandExtension;
  if (!extension) return { handled: false };
  const extended = await extension(ctx, req);
  return extended.handled ? handled(extended.result) : { handled: false };
}

function handled(result: unknown): DomainDispatchResult {
  return { handled: true, result };
}

function methodNotFound(req: CdpRequest): CdpResponse {
  return {
    id: req.id,
    error: { code: -32601, message: `'${req.method}' wasn't found` },
    sessionId: req.sessionId,
  };
}

async function handleEmulation(
  ctx: DispatchCtx,
  req: CdpRequest,
): Promise<Record<string, unknown>> {
  const target = emulationTarget(ctx, req.sessionId);
  if (!target) return {};

  switch (req.method) {
    case "Emulation.setDeviceMetricsOverride":
      return setDeviceMetrics(ctx, target, req);
    case "Emulation.setEmulatedMedia":
      return setEmulatedMedia(ctx, target, req);
    case "Emulation.setUserAgentOverride":
      target.userAgentOverride =
        typeof req.params?.userAgent === "string" ? req.params.userAgent : "";
      return {};
    default:
      return {};
  }
}

function emulationTarget(ctx: DispatchCtx, sessionId: string | undefined): TargetState | null {
  if (sessionId) return targetForSession(ctx, sessionId) ?? firstPageTarget(ctx) ?? null;
  return firstPageTarget(ctx) ?? null;
}

function targetForSession(ctx: DispatchCtx, sessionId: string): TargetState | undefined {
  for (const target of ctx.browser.targets.values()) {
    if (target.sessions.has(sessionId)) return target;
  }
  return undefined;
}

function firstPageTarget(ctx: DispatchCtx): TargetState | undefined {
  for (const target of ctx.browser.targets.values()) {
    if (target.type === "page") return target;
  }
  return undefined;
}

async function setDeviceMetrics(
  ctx: DispatchCtx,
  target: TargetState,
  req: Extract<CdpRequest, { method: "Emulation.setDeviceMetricsOverride" }>,
): Promise<Record<string, unknown>> {
  const width = viewportDimension(req.params?.width);
  const height = viewportDimension(req.params?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return {};
  const vp = clampViewport(width, height);
  target.viewportWidth = vp.width;
  target.viewportHeight = vp.height;
  await sessionOf(ctx, target).callIfLive.setViewport({
    width: target.viewportWidth,
    height: target.viewportHeight,
  });
  return {};
}

function viewportDimension(value: unknown): number {
  return typeof value === "number" ? value : NaN;
}

async function setEmulatedMedia(
  ctx: DispatchCtx,
  target: TargetState,
  req: Extract<CdpRequest, { method: "Emulation.setEmulatedMedia" }>,
): Promise<Record<string, unknown>> {
  const media = typeof req.params?.media === "string" ? req.params.media : "";
  const normalised = media === "print" ? "print" : "screen";
  target.emulatedMedia = normalised;
  await sessionOf(ctx, target).callIfLive.setMediaType({ media: normalised });
  return {};
}
