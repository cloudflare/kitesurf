// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Routes CDP commands to target sessions, domain handlers, and host extensions.

import type {
  BrowserState,
  CdpClientState,
  CdpRequest,
  CdpResponse,
  EventEmitter,
  TargetState,
} from "./types.ts";
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
import { handleLog } from "./log.ts";
import { handleFetch } from "./fetch.ts";
import { handleInput } from "./input.ts";
import { handleKitesurf } from "./kitesurf.ts";
import { handleWebMcp } from "./webmcp.ts";
import { handleDomStorage } from "./dom-storage.ts";
import { handleDebugger } from "./debugger.ts";
import { handleCss } from "./css.ts";
import { handleAccessibility } from "./accessibility.ts";
import { sessionOf } from "./page-session.ts";
import { clampViewport, DEFAULT_VIEWPORT_HEIGHT, DEFAULT_VIEWPORT_WIDTH } from "./viewport.ts";
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

/** The part of an ExecutionContext a browser session uses. A host builds one without a cast. */
export type SessionContext = Pick<
  ExecutionContext,
  "waitUntil" | "passThroughOnException" | "exports" | "props"
>;

export interface DispatchCtx {
  browser: BrowserState;
  emit: EventEmitter;
  commandExtension?: EngineCdpCommandExtension;
  /** Host request blocker for this connection; also registered for SandboxOutbound. */
  requestBlocker?: RequestBlocker;
  env: {
    LOADER: WorkerLoader;
    FONT_ASSETS: Fetcher;
    KITESURF_NATIVE_EVAL?: string;
    KITESURF_RESOURCE_DRAIN_QUIET_TURNS?: string;
    KITESURF_LAG_WATCHDOG?: string;
    // Per-page-isolate deployment budgets: CPU cap on LOADER.load,
    // wall-clock kill timer per generation. See eval/page-script.ts.
    KITESURF_PAGE_CPU_MS_CAP?: string;
    KITESURF_PAGE_WALL_MS_CAP?: string;
    KITESURF_ALLOW_PRIVATE_NETWORK?: string;
    HOST_TRACER?: Tracer;
    HOST_CLOCK?: HostClock;
  };
  ctx: SessionContext;
  connectionId: string;
  analytics: KitesurfAnalytics;
  // The client this context acts for. Background work that captured the context keeps acting
  // for that client, even after it leaves.
  client: CdpClientState;
  // Sends an event to this context's client alone, bypassing the session's routing.
  emitToClient: EventEmitter;
  // The contexts of every client connected to the session, this one included while connected.
  // Announcements that Chrome makes to each client with a matching setting loop over these.
  peers: () => readonly DispatchCtx[];
}

// These act on the browser context of a frame session's page, so they skip the OOPIF split
// (network.ts storageSessionTarget, dom-storage.ts).
const CONTEXT_STORAGE_METHODS = new Set([
  "Storage.clearDataForOrigin",
  "Storage.clearDataForStorageKey",
  "DOMStorage.enable",
  "DOMStorage.disable",
  "DOMStorage.getDOMStorageItems",
  "DOMStorage.setDOMStorageItem",
  "DOMStorage.removeDOMStorageItem",
  "DOMStorage.clear",
]);

export async function dispatch(ctx: DispatchCtx, req: CdpRequest): Promise<CdpResponse> {
  const [domain] = req.method.split(".", 1);

  ctx.browser.networkEvents.drain();

  try {
    if (req.method === "Browser.getVersion") {
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
    if (req.sessionId && req.sessionId === ctx.client.memoryTargets.renderer) {
      const result = await handleRendererSession(ctx, req);
      ctx.browser.networkEvents.drain();
      return { id: req.id, result: result ?? {}, sessionId: req.sessionId };
    }
    if (req.sessionId && req.sessionId === ctx.client.memoryTargets.engine) {
      const result = await handleEngineSession(ctx, req);
      ctx.browser.networkEvents.drain();
      return { id: req.id, result: result ?? {}, sessionId: req.sessionId };
    }
    if (req.sessionId && !CONTEXT_STORAGE_METHODS.has(req.method)) {
      const oopif = findOopifFrameBySession(ctx, req.sessionId);
      if (oopif) {
        const result = await handleOopifSession(ctx, req, oopif.target, oopif.frame);
        ctx.browser.networkEvents.drain();
        return { id: req.id, result: result ?? {}, sessionId: req.sessionId };
      }
    }
    let result: unknown;
    switch (domain) {
      case "Target":
        result = await handleTarget(ctx, req);
        break;
      case "Page":
        result = await handlePage(ctx, req);
        break;
      case "Runtime":
        result = await handleRuntime(ctx, req);
        break;
      case "DOM":
        result = await handleDom(ctx, req);
        break;
      case "Network":
      case "Storage":
        result = await handleNetwork(ctx, req);
        break;
      case "Log":
        result = await handleLog(ctx, req);
        break;
      case "Fetch":
        result = await handleFetch(ctx, req);
        break;
      case "Input":
        result = await handleInput(ctx, req, undefined, { replyOnDispatch: true });
        break;
      case "Kitesurf": {
        result = await handleKitesurf(ctx, req);
        if (result === CDP_COMMAND_UNHANDLED) {
          // Public handlers win; the host only sees commands they decline.
          const extension = ctx.commandExtension;
          if (!extension) {
            ctx.browser.networkEvents.drain();
            return methodNotFound(req);
          }
          const extended = await extension(ctx, req);
          if (!extended.handled) {
            ctx.browser.networkEvents.drain();
            return methodNotFound(req);
          }
          result = extended.result;
        }
        break;
      }
      case "DOMStorage":
        // Chrome has DOMStorage on page and frame sessions only. A page-mode client has no ids.
        if (!req.sessionId && ctx.client.connectionMode !== "page") {
          ctx.browser.networkEvents.drain();
          return methodNotFound(req);
        }
        result = await handleDomStorage(ctx, req);
        break;
      case "WebMCP":
        result = await handleWebMcp(ctx, req);
        break;
      case "Debugger":
        result = await handleDebugger(ctx, req);
        break;
      case "CSS":
        result = await handleCss(ctx, req);
        break;
      case "Accessibility":
        result = await handleAccessibility(ctx, req);
        break;
      case "Emulation":
        result = await handleEmulation(ctx, req);
        break;
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
      case "FedCm":
      case "Headless":
      case "HeapProfiler":
      case "IndexedDB":
      case "Inspector":
      case "IO":
      case "LayerTree":
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
        result = {};
        break;
      default:
        return methodNotFound(req);
    }

    ctx.browser.networkEvents.drain();

    return {
      id: req.id,
      result: result ?? {},
      sessionId: req.sessionId,
    };
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
  let target: TargetState | null = null;
  if (req.sessionId) {
    for (const t of ctx.browser.targets.values()) {
      if (t.sessions.has(req.sessionId)) {
        target = t;
        break;
      }
    }
  }
  if (!target) {
    for (const t of ctx.browser.targets.values()) {
      if (t.type === "page") {
        target = t;
        break;
      }
    }
  }
  if (!target) return {};

  if (req.method === "Emulation.setDeviceMetricsOverride") {
    const width = typeof req.params?.width === "number" ? req.params.width : NaN;
    const height = typeof req.params?.height === "number" ? req.params.height : NaN;
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return {};
    }
    const vp = clampViewport(width, height);
    target.viewportWidth = vp.width;
    target.viewportHeight = vp.height;
    const scale = req.params?.deviceScaleFactor;
    target.deviceScaleFactor = typeof scale === "number" && scale > 0 ? scale : 1;
    target.overrideOwners.set("deviceMetrics", ctx.client.id);
    await sessionOf(ctx, target).callIfLive.setViewport({
      width: target.viewportWidth,
      height: target.viewportHeight,
    });
    return {};
  }

  if (req.method === "Emulation.setEmulatedMedia") {
    const media = typeof req.params?.media === "string" ? req.params.media : "";
    const normalised = media === "print" ? "print" : "screen";
    target.emulatedMedia = normalised;
    target.overrideOwners.set("emulatedMedia", ctx.client.id);
    await sessionOf(ctx, target).callIfLive.setMediaType({
      media: normalised,
    });
    return {};
  }

  if (req.method === "Emulation.setUserAgentOverride") {
    target.userAgentOverride =
      typeof req.params?.userAgent === "string" ? req.params.userAgent : "";
    target.overrideOwners.set("userAgent", ctx.client.id);
    return {};
  }

  return {};
}

/**
 * Clears the overrides that a departed client set, so its headers, user agent and emulation do
 * not apply to the clients that remain. The live page gets the default media and viewport back.
 */
export function releaseClientOverrides(ctx: DispatchCtx, clientId: string): void {
  for (const target of ctx.browser.targets.values()) {
    for (const [kind, owner] of Array.from(target.overrideOwners)) {
      if (owner !== clientId) continue;
      target.overrideOwners.delete(kind);
      switch (kind) {
        case "extraHttpHeaders":
          target.extraHttpHeaders = {};
          break;
        case "userAgent":
          target.userAgentOverride = "";
          break;
        case "emulatedMedia":
          target.emulatedMedia = "screen";
          void sessionOf(ctx, target)
            .callIfLive.setMediaType({ media: "screen" })
            .catch(() => {});
          break;
        case "deviceMetrics":
          target.viewportWidth = null;
          target.viewportHeight = null;
          target.deviceScaleFactor = 1;
          void sessionOf(ctx, target)
            .callIfLive.setViewport({
              width: DEFAULT_VIEWPORT_WIDTH,
              height: DEFAULT_VIEWPORT_HEIGHT,
            })
            .catch(() => {});
          break;
      }
    }
  }
}
