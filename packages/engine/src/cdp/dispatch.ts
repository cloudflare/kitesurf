// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Routes CDP commands to target sessions, domain handlers, and host extensions.

import type {
  BrowserState,
  CdpClientState,
  CdpReplyBody,
  CdpRequest,
  CdpResponse,
  EventEmitter,
  TargetState,
} from "./types.ts";
import type { RequestBlocker } from "../request-blocker.ts";
import { defineDomain, type CdpDomain } from "./domain.ts";
import { CDP_COMMAND_UNHANDLED } from "./types.ts";
import {
  targetDomain,
  rendererSession,
  engineSession,
  oopifSession,
  findOopifFrameBySession,
} from "./target.ts";
import { pageDomain } from "./page.ts";
import { runtimeDomain } from "./runtime.ts";
import { domDomain } from "./dom.ts";
import { networkDomain, storageDomain } from "./network.ts";
import { logDomain } from "./log.ts";
import { fetchDomain } from "./fetch.ts";
import { inputDomain } from "./input.ts";
import { kitesurfDomain } from "./kitesurf.ts";
import { webMcpDomain } from "./webmcp.ts";
import { domStorageDomain } from "./dom-storage.ts";
import { debuggerDomain } from "./debugger.ts";
import { cssDomain } from "./css.ts";
import { accessibilityDomain } from "./accessibility.ts";
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
        } satisfies CdpReplyBody<"Browser.getVersion">,
        sessionId: req.sessionId,
      };
    }
    if (req.sessionId && req.sessionId === ctx.browser.rendererSessionId) {
      const result = await syntheticSessionReply(ctx, req, rendererSession);
      ctx.browser.networkEvents.drain();
      return { id: req.id, result: result ?? {}, sessionId: req.sessionId };
    }
    if (req.sessionId && req.sessionId === ctx.browser.engineSessionId) {
      const result = await syntheticSessionReply(ctx, req, engineSession);
      ctx.browser.networkEvents.drain();
      return { id: req.id, result: result ?? {}, sessionId: req.sessionId };
    }
    if (req.sessionId && !CONTEXT_STORAGE_METHODS.has(req.method)) {
      const oopif = findOopifFrameBySession(ctx, req.sessionId);
      if (oopif) {
        const result = await runDomain(ctx, req, oopifSession, oopif.target, oopif.frame);
        ctx.browser.networkEvents.drain();
        return { id: req.id, result: result ?? {}, sessionId: req.sessionId };
      }
    }
    let result: unknown;
    switch (domain) {
      case "Target":
        result = await runDomain(ctx, req, targetDomain);
        break;
      case "Page":
        result = await runDomain(ctx, req, pageDomain);
        break;
      case "Runtime":
        result = await runDomain(ctx, req, runtimeDomain);
        break;
      case "DOM":
        result = await runDomain(ctx, req, domDomain);
        break;
      case "Network":
        result = await runDomain(ctx, req, networkDomain);
        break;
      case "Storage":
        result = await runDomain(ctx, req, storageDomain);
        break;
      case "Log":
        result = await runDomain(ctx, req, logDomain);
        break;
      case "Fetch":
        result = await runDomain(ctx, req, fetchDomain);
        break;
      case "Input":
        result = await runDomain(ctx, req, inputDomain, undefined, { replyOnDispatch: true });
        break;
      case "Kitesurf": {
        result = await kitesurfDomain.run(ctx, req);
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
        result = await runDomain(ctx, req, domStorageDomain);
        break;
      case "WebMCP":
        result = await webMcpDomain.run(ctx, req);
        // Unlike the other domains, WebMCP has always refused a method it does not define.
        if (result === CDP_COMMAND_UNHANDLED) {
          throw new Error(`${req.method} is not a recognized WebMCP method`);
        }
        break;
      case "Debugger":
        result = await runDomain(ctx, req, debuggerDomain);
        break;
      case "CSS":
        result = await runDomain(ctx, req, cssDomain);
        break;
      case "Accessibility":
        result = await runDomain(ctx, req, accessibilityDomain);
        break;
      case "Emulation":
        result = await runDomain(ctx, req, emulationDomain);
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

// A switch handler answers {} for a method it has no case for. Until every domain is defined
// method by method, a defined domain does the same, and logs the method so it can be defined.
async function runDomain<A extends unknown[]>(
  ctx: DispatchCtx,
  req: CdpRequest,
  domain: CdpDomain<A>,
  ...args: A
): Promise<unknown> {
  const result = await domain.run(ctx, req, ...args);
  if (result !== CDP_COMMAND_UNHANDLED) return result;
  warnUndefinedMethod(ctx.browser, req.method);
  return {};
}

// The engine and renderer targets answer {} to any command their table does not define, by design.
async function syntheticSessionReply(
  ctx: DispatchCtx,
  req: CdpRequest,
  session: CdpDomain,
): Promise<unknown> {
  const result = await session.run(ctx, req);
  return result === CDP_COMMAND_UNHANDLED ? {} : result;
}

// The client names the method, so the log is capped per connection and each name is cut short.
const MAX_UNDEFINED_METHOD_WARNINGS = 32;
const undefinedMethodWarnings = new WeakMap<BrowserState, Set<string>>();

function warnUndefinedMethod(browser: BrowserState, method: string): void {
  let warned = undefinedMethodWarnings.get(browser);
  if (!warned) {
    warned = new Set();
    undefinedMethodWarnings.set(browser, warned);
  }
  const name = method.slice(0, 128);
  if (warned.has(name) || warned.size >= MAX_UNDEFINED_METHOD_WARNINGS) return;
  warned.add(name);
  console.warn(`[kitesurf-cdp] ${JSON.stringify(name)} is not defined; answering {}`);
}

function methodNotFound(req: CdpRequest): CdpResponse {
  return {
    id: req.id,
    error: { code: -32601, message: `'${req.method}' wasn't found` },
    sessionId: req.sessionId,
  };
}

function emulationTarget(ctx: DispatchCtx, sessionId: string | undefined): TargetState | null {
  if (sessionId) {
    for (const t of ctx.browser.targets.values()) {
      if (t.sessions.has(sessionId)) return t;
    }
  }
  for (const t of ctx.browser.targets.values()) {
    if (t.type === "page") return t;
  }
  return null;
}

const emulationDomain = defineDomain("Emulation", {
  context: (ctx, req) => ({ ctx, target: emulationTarget(ctx, req.sessionId) }),
  methods: {
    "Emulation.setDeviceMetricsOverride": async ({ ctx, target }, req) => {
      if (!target) return {};
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
      await sessionOf(ctx, target).callIfLive.setViewport({
        width: target.viewportWidth,
        height: target.viewportHeight,
      });
      return {};
    },

    "Emulation.setEmulatedMedia": async ({ ctx, target }, req) => {
      if (!target) return {};
      const media = typeof req.params?.media === "string" ? req.params.media : "";
      const normalised = media === "print" ? "print" : "screen";
      target.emulatedMedia = normalised;
      await sessionOf(ctx, target).callIfLive.setMediaType({
        media: normalised,
      });
      return {};
    },

    "Emulation.setUserAgentOverride": ({ target }, req) => {
      if (!target) return {};
      target.userAgentOverride =
        typeof req.params?.userAgent === "string" ? req.params.userAgent : "";
      return {};
    },
  },
});
