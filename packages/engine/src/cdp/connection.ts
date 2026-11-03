// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Owns one CDP WebSocket's state, event flow, deadlines, and resource cleanup.

import { nanoid } from "nanoid";
import { dispatch, type DispatchCtx } from "./dispatch.ts";
import { traceSpan } from "../tracing.ts";
import { endLocalTraceSession, localTraceEventWrap } from "../tracing-local.ts";
import {
  SKIP_SPECULATIVE_RASTER_HEADER,
  parseCdpRequest,
  type BrowserState,
  type CdpEvent,
  type CdpRequest,
  type CdpResponse,
} from "./types.ts";
import { ensureBrowserTarget, createPageTarget, engineMemoryBreakdown } from "./target.ts";
import { pumpBackgroundEvents, teardownOopifStubs } from "./page.ts";
import { retireStub } from "./page-script-generation.ts";
import { releaseAllDomHandles } from "./dom-release.ts";
import { cancelAndRemoveTargetWheelQueues } from "./wheel-queue.ts";
import { stopSceneStreams } from "./scene-stream.ts";
import { DynamicWorkerBudget } from "../eval/worker-budget.ts";
import { DedicatedWorkers } from "./dedicated-workers.ts";
import { createCookieJar } from "../cookies.ts";
import {
  NetworkEventTracker,
  registerTracker,
  unregisterTracker,
} from "./network-events-registry.ts";
import { registerCookieJar, unregisterConnectionCookieJars } from "./cookie-jar-registry.ts";
import { disposeWebMcpConnection } from "./webmcp.ts";
import { dropConnectionImages } from "../eval/resource-store.ts";
import type { ExternalOutbound } from "../eval/external-outbound.ts";
import { createSandboxOutboundOverride, type SandboxOutboundExports } from "../eval/outbound.ts";
import { unregisterOutboundFilters } from "./outbound-filter-registry.ts";
import { registerRequestBlocker, unregisterRequestBlocker } from "../request-blocker.ts";
import { unregisterInterception, drainInterception } from "./fetch-interception.ts";
import {
  KitesurfAnalytics,
  SafePerformance,
  SESSION_ID_HEADER,
  emitSessionEnd,
  type HostClockTimer,
} from "../observability.ts";
import { resolveConnectionOptions, type EngineHost } from "../host.ts";
import type { PageIsolateCapOverrides } from "../eval/page-script.ts";
import { buildDispatchEnv } from "./dispatch-env.ts";
import { markArrival } from "./arrival.ts";
import { makeWallClock } from "../eval/host-clock.ts";
// Wrangler generates the ambient `Env` declaration from wrangler.jsonc.

const NOISY_CDP_METHODS = new Set<string>([
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Page.screencastFrameAck",
]);

const IDLE_SESSION_MS = 10 * 60_000;
const MAX_SESSION_MS = 60 * 60_000;
const BACKGROUND_EVENT_DRAIN_INTERVAL_MS = 200;
const CDP_CONNECTION_ID_LENGTH = 10;
const CDP_DEBUG_SESSION_ID_PREFIX_CHARS = 6;

/**
 * Accepts a CDP WebSocket request and returns a 101 response with its session ID.
 * `ctx.waitUntil` keeps connection state alive until the socket closes or errors.
 */
export async function handleWebSocket(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  onCtx?: (dispatchCtx: DispatchCtx) => void,
  opts?: {
    exemptIdleDeadline?: boolean;
    externalOutbound?: ExternalOutbound;
    onDispatch?: (dispatch: (req: CdpRequest) => Promise<CdpResponse>) => void;
    host?: EngineHost;
  },
): Promise<Response> {
  // Also used as the analytics session ID and log correlation key.
  const connectionId = nanoid(CDP_CONNECTION_ID_LENGTH);
  const options = resolveConnectionOptions(request, connectionId, opts?.host);

  // External sessions provide their outbound policy before dispatch; regular
  // WebSocket upgrades use the default policy.

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

  server.accept();

  let initialLayoutMode: "full" | "off" = "full";
  // Optional initialUrl from the `/?url=` inspector redirect; navigate without
  // requiring the inspector user to enter the URL manually.
  let initialUrl: string | null = null;
  let debug = false;
  let cdpDebug = false;
  let idleMs = IDLE_SESSION_MS;
  let maxSessionMs = MAX_SESSION_MS;
  const isolateCapOverrides: PageIsolateCapOverrides = {};
  let connectionMode: "page" | "browser" = "browser";
  try {
    const wsUrl = new URL(request.url);
    if (wsUrl.pathname.startsWith("/devtools/page/")) {
      connectionMode = "page";
    }
    const param = wsUrl.searchParams.get("layout");
    if (param === "off" || param === "0" || param === "false") {
      initialLayoutMode = "off";
    }
    const iu = wsUrl.searchParams.get("initialUrl");
    if (iu) {
      try {
        const parsed = new URL(iu);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          initialUrl = parsed.toString();
        }
      } catch {}
    }
    const dbg = wsUrl.searchParams.get("debug");
    if (dbg === "1" || dbg === "true") {
      debug = true;
    }
    const cdpDbg = wsUrl.searchParams.get("cdpDebug");
    if (cdpDbg === "1" || cdpDbg === "true") {
      cdpDebug = true;
    }
    const cpuCapRaw = Number.parseInt(wsUrl.searchParams.get("ksCpuCapMs") ?? "", 10);
    if (Number.isFinite(cpuCapRaw) && cpuCapRaw > 0) {
      isolateCapOverrides.cpuMs = cpuCapRaw;
    }
    const wallCapRaw = Number.parseInt(wsUrl.searchParams.get("ksWallCapMs") ?? "", 10);
    if (Number.isFinite(wallCapRaw) && wallCapRaw > 0) {
      isolateCapOverrides.wallMs = wallCapRaw;
    }
    const idleRaw = Number.parseInt(wsUrl.searchParams.get("ksIdleMs") ?? "", 10);
    if (Number.isFinite(idleRaw) && idleRaw > 0) {
      idleMs = Math.min(idleMs, idleRaw);
    }
    const maxSessionRaw = Number.parseInt(wsUrl.searchParams.get("ksMaxSessionMs") ?? "", 10);
    if (Number.isFinite(maxSessionRaw) && maxSessionRaw > 0) {
      maxSessionMs = Math.min(maxSessionMs, maxSessionRaw);
    }
  } catch {}

  // The WebSocket owns this closure's state; keep the invocation alive until close or error.
  const wsLifetime = new Promise<void>((resolve) => {
    server.addEventListener("close", () => resolve());
    server.addEventListener("error", () => resolve());
  });
  ctx.waitUntil(wsLifetime);

  let sendCount = 0;
  let sendBytesTotal = 0;
  let sendFailCount = 0;
  let screencastFramesSent = 0;
  let screencastFrameBytesSent = 0;
  let screencastAcksReceived = 0;
  let wsClosing = false;
  let memAtClose: ReturnType<typeof engineMemoryBreakdown> | null = null;

  const send = (payload: unknown) => {
    if (wsClosing) {
      sendFailCount++;
      return;
    }
    try {
      const str = JSON.stringify(payload);
      if (
        payload &&
        typeof payload === "object" &&
        (payload as { method?: string }).method === "Page.screencastFrame"
      ) {
        screencastFramesSent++;
        screencastFrameBytesSent += str.length;
        if (screencastFramesSent % 5 === 1) {
          console.log(
            `[kitesurf-ws] screencastFrame #${screencastFramesSent} ` +
              `bytes=${str.length} totalBytes=${screencastFrameBytesSent} ` +
              `acksReceived=${screencastAcksReceived}`,
          );
        }
      }
      server.send(str);
      sendCount++;
      sendBytesTotal += str.length;
    } catch (err) {
      sendFailCount++;
      const msg =
        err instanceof Error
          ? `${err.name}: ${err.message}`
          : err && typeof err === "object" && "message" in err
            ? `${(err as { name?: string }).name ?? "Error"}: ${(err as { message?: string }).message ?? ""}`
            : String(err);
      console.error(
        `[kitesurf-ws] send failed (#${sendFailCount}, ` +
          `sendCount=${sendCount}, totalBytes=${sendBytesTotal}): ${msg}`,
      );
    }
  };

  const emit = (event: CdpEvent) => send(event);

  // Retain response bodies only when Network.enable requests buffering.
  const networkEvents = new NetworkEventTracker(emit, connectionId);

  const analytics = new KitesurfAnalytics(
    {
      sessionId: connectionId,
      entrypoint: options.entrypoint,
      connectionMode,
      environment: env.KITESURF_ENV ?? "",
      buildVersion: env.KITESURF_VERSION ?? "",
      colo: (request.cf as { colo?: string } | undefined)?.colo ?? "",
    },
    new SafePerformance((env as { HOST_CLOCK?: HostClockTimer }).HOST_CLOCK),
    {
      factory: opts?.host?.telemetry,
      request,
      props: ctx.props,
      env,
      waitUntil: (p) => ctx.waitUntil(p),
    },
  );

  registerTracker(connectionId, networkEvents);
  const requestBlocker = opts?.host?.requestBlocker;
  if (requestBlocker) registerRequestBlocker(connectionId, requestBlocker);

  const cookies = createCookieJar();
  registerCookieJar(connectionId, cookies);
  const workerBudget = new DynamicWorkerBudget();
  const browser: BrowserState = {
    targets: new Map(),
    sandboxOutbound: createSandboxOutboundOverride(
      (ctx as ExecutionContext & { exports: SandboxOutboundExports }).exports,
      env,
      opts?.externalOutbound,
      opts?.externalOutbound ? undefined : opts?.host?.egress?.(env, ctx),
    ),
    contexts: new Map(),
    nextBrowserContextId: 1,
    autoAttach: false,
    flatten: false,
    cookies,
    screencasts: new Map(),
    styleCache: new Map(),
    imageCache: new Map(),
    networkEvents,
    layoutMode: initialLayoutMode,
    cdpDebug,
    isolateCapOverrides,
    connectionMode,
    ttyKeyboard: false,
    preNavScripts: new Map<string, string>(),
    learnedInsertedScripts: new Map(),
    pendingBindings: new Set<string>(),
    execContextSeq: 3,
    runtimeEnabledSessions: new Set<string>(),
    rendererManager: null,
    workerBudget,
    dedicatedWorkers: new DedicatedWorkers(workerBudget, (p) => ctx.waitUntil(p)),
    skipSpeculativeRaster: request.headers.get(SKIP_SPECULATIVE_RASTER_HEADER) === "1",
    skipPartialRaster: env.KITESURF_DISABLE_PARTIAL_RASTER === "1",
    // Deferred-fonts opt-in. See BrowserState.fontDefer.
    fontDefer: options.fontDefer,
    rendererSessionId: null,
    engineSessionId: null,
    wsClosing: false,
    attributionHeaders: pickHeaders(request, opts?.host?.attributionHeaders),
  };

  browser.workerBudget.countPageTargets = () => {
    let n = 0;
    for (const t of browser.targets.values()) {
      if (t.type !== "page") continue;
      if (t.pageScriptLease || t.navigateGeneration > 0) n += 1;
    }
    return n;
  };

  const dispatchCtx: DispatchCtx = {
    browser,
    emit,
    // Host bindings belong to this WebSocket's lifetime, not a worker-global cache.
    commandExtension: opts?.host?.createCdpCommandExtension?.(env),
    requestBlocker,
    env: buildDispatchEnv(env),
    ctx,
    connectionId,
    analytics,
  };

  const tracedDispatch = (req: CdpRequest) =>
    NOISY_CDP_METHODS.has(req.method)
      ? dispatch(dispatchCtx, req)
      : traceSpan(env.HOST_TRACER, "cdp." + req.method, () => dispatch(dispatchCtx, req), {
          connectionId,
        });

  try {
    onCtx?.(dispatchCtx);
    opts?.onDispatch?.(tracedDispatch);
  } catch (err) {
    console.warn("[kitesurf-ws] in-process consumer threw:", err);
  }

  ensureBrowserTarget(dispatchCtx);
  const initialPage = createPageTarget(dispatchCtx, "about:blank");
  emit({
    method: "Target.targetCreated",
    params: { targetInfo: { ...visibleInfo(initialPage, connectionMode) } },
  });

  const sessionOpenedAt = Date.now();
  let lastClientMessageAt = sessionOpenedAt;
  let deadlineFired = false;

  const closeIfExpired = (): boolean => {
    if (deadlineFired || wsClosing) return deadlineFired;
    const now = Date.now();
    const idleExempt = opts?.exemptIdleDeadline === true;
    const reason =
      now - sessionOpenedAt > maxSessionMs
        ? `kitesurf: session exceeded ${maxSessionMs} ms`
        : !idleExempt && now - lastClientMessageAt > idleMs
          ? `kitesurf: idle for ${idleMs} ms with no client CDP traffic`
          : null;
    if (reason === null) return false;
    deadlineFired = true;
    console.warn(`[kitesurf-ws] closing session ${connectionId}: ${reason}`);
    try {
      server.close(1001, reason);
    } catch {}
    return true;
  };

  const drainTimer = setInterval(() => {
    if (closeIfExpired()) return;
    if (browser.targets.size === 0) return;
    networkEvents.drain();
    drainInterception(connectionId);
    for (const t of browser.targets.values()) {
      pumpBackgroundEvents(dispatchCtx, t);
    }
  }, BACKGROUND_EVENT_DRAIN_INTERVAL_MS);
  ctx.waitUntil(
    new Promise<void>((resolve) => {
      const cleanup = () => {
        clearInterval(drainTimer);
        resolve();
      };
      server.addEventListener("close", cleanup, { once: true });
      server.addEventListener("error", cleanup, { once: true });
    }),
  );

  if (initialUrl !== null) {
    const syntheticReq: CdpRequest = {
      id: -1,
      method: "Page.navigate",
      params: { url: initialUrl },
    };
    void (async () => {
      try {
        const response = await tracedDispatch(syntheticReq);
        if (debug) {
          console.log("[cdp auto-navigate]", initialUrl, "->", JSON.stringify(response));
        }
      } catch (err) {
        console.error("[cdp auto-navigate threw]", err);
      }
    })();
  }

  const rejoinLocalTrace = localTraceEventWrap(env);
  const arrivalClock = makeWallClock(dispatchCtx.env);

  server.addEventListener("message", (event) => {
    // Preserve queue delay for request-boundary timing.
    const arrivedAt = arrivalClock();
    lastClientMessageAt = Date.now();
    void rejoinLocalTrace(async () => {
      const parsed = parseCdpRequest(
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer),
      );
      if (!parsed.ok) {
        send(parsed.error);
        return;
      }
      const req = parsed.request;
      markArrival(req, arrivedAt);

      if (debug && !NOISY_CDP_METHODS.has(req.method)) {
        console.log(
          "[cdp <-]",
          req.id,
          req.method,
          req.sessionId ? `(s=${req.sessionId.slice(0, CDP_DEBUG_SESSION_ID_PREFIX_CHARS)})` : "",
        );
      }

      if (req.method === "Page.screencastFrameAck") {
        screencastAcksReceived++;
      }

      try {
        const response = await tracedDispatch(req);
        if (debug && !NOISY_CDP_METHODS.has(req.method)) {
          console.log("[cdp ->]", req.id, req.method, "ok");
        }
        send(response);
        // Chrome exits after it answers Browser.close, which drops the socket. Clients behind
        // a proxy wait for that drop, so `browser.close()` hangs unless the engine closes too.
        if (req.method === "Browser.close" && !("error" in response)) {
          try {
            server.close(1000, "Browser.close");
          } catch {}
        }
      } catch (err) {
        console.error("[cdp dispatch threw]", req.method, err);
        send({
          id: req.id,
          error: { code: -32000, message: String(err) },
          sessionId: req.sessionId,
        });
      }
    });
  });

  server.addEventListener("close", (ev) => {
    const closeEv = ev as CloseEvent;
    emitSessionEnd(analytics, {
      endReason: "close",
      closeCode: closeEv.code ?? 0,
      wasClean: closeEv.wasClean ? 1 : 0,
    });
    wsClosing = true;
    browser.wsClosing = true;
    // Stop scene streams before retiring their targets and renderer.
    stopSceneStreams(browser);
    for (const state of browser.screencasts.values()) state.stopped = true;
    browser.screencasts.clear();
    // Close rather than drop the renderer manager, so a capture still running fails instead of
    // creating a new manager and loading a renderer after the connection is gone.
    try {
      browser.rendererManager?.close("engine WS closed");
    } catch {}
    unregisterTracker(connectionId);
    memAtClose = engineMemoryBreakdown(browser);
    networkEvents.dispose();
    unregisterOutboundFilters(connectionId);
    unregisterRequestBlocker(connectionId);
    unregisterInterception(connectionId);
    disposeWebMcpConnection(connectionId);
    unregisterConnectionCookieJars(connectionId, browser.contexts.keys());
    dropConnectionImages(connectionId);
    browser.dedicatedWorkers.terminateAll("engine WS closed");
    for (const target of browser.targets.values()) {
      // An in-flight navigate would otherwise load and publish a PageScript after this loop has
      // retired the target, and nothing would ever kill it.
      try {
        target.pendingNavAbort?.abort();
      } catch {}
      target.pendingNavAbort = null;
      target.navigateGeneration++;
      void cancelAndRemoveTargetWheelQueues(browser, target.targetId);
      teardownOopifStubs(target, "engine WS closed", undefined, {
        budget: browser.workerBudget,
        waitUntil: (promise) => ctx.waitUntil(promise),
      });
      void retireStub(target, "wsClosed", "engine WS closed", {
        budget: browser.workerBudget,
        waitUntil: (promise) => ctx.waitUntil(promise),
      });
      releaseAllDomHandles(target);
    }
    rejoinLocalTrace(() => endLocalTraceSession(env));
  });

  server.addEventListener("error", (ev) => {
    const e = ev as ErrorEvent & {
      error?: { name?: string; message?: string; stack?: string };
    };
    const msg = e.error?.message ?? e.message ?? "";
    const postClose = wsClosing && msg.includes("Network connection lost");
    if (!wsClosing) {
      emitSessionEnd(analytics, {
        endReason: "error",
        closeCode: 0,
        wasClean: 0,
      });
    }
    const detail = {
      message: e.message,
      type: e.type,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      error_name: e.error?.name,
      error_message: e.error?.message,
      counters: {
        sendCount,
        sendBytesTotal,
        sendFailCount,
        screencastFramesSent,
        screencastFrameBytesSent,
        screencastAcksReceived,
      },
    };
    if (postClose) {
      console.log(`[kitesurf-ws] post-close async settled: ${JSON.stringify(detail)}`);
    } else {
      console.error(`[kitesurf-ws] error: ${JSON.stringify(detail)}`);
    }
  });

  server.addEventListener("close", (ev) => {
    const c = ev as CloseEvent;
    const mem = memAtClose ?? engineMemoryBreakdown(browser);
    console.log(
      `[kitesurf-ws] close: code=${c.code} reason="${c.reason}" wasClean=${c.wasClean} ` +
        `sendCount=${sendCount} sendBytesTotal=${sendBytesTotal} ` +
        `sendFailCount=${sendFailCount} ` +
        `screencastFramesSent=${screencastFramesSent} ` +
        `screencastFrameBytesSent=${screencastFrameBytesSent} ` +
        `screencastAcksReceived=${screencastAcksReceived} ` +
        `engineWasmBytes=${mem.wasmBytes} ` +
        `engineWasmDeltaBytes=${mem.wasmDeltaBytes} ` +
        `retainedBodyBytes=${mem.retainedBodyBytes} ` +
        `retainedBodyBytesIsolate=${mem.retainedBodyBytesIsolate} ` +
        `retainedRequestCount=${mem.retainedRequestCount} ` +
        `retainedImageBytes=${mem.retainedImageBytes} ` +
        `retainedImageCount=${mem.retainedImageCount} ` +
        `fontAssetCacheBytes=${mem.fontAssetCacheBytes} ` +
        `engineAccountedBytes=${mem.accountedBytes}`,
    );
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: { [SESSION_ID_HEADER]: connectionId },
  });
}

function pickHeaders(request: Request, names: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = request.headers.get(name);
    if (v) out[name] = v;
  }
  return out;
}

function visibleInfo(
  t: { targetId: string; type: string; url: string; title: string },
  connectionMode: "page" | "browser",
) {
  return {
    targetId: t.targetId,
    type: t.type,
    title: t.title,
    url: t.url,
    attached: connectionMode === "page" && t.type === "page",
    canAccessOpener: false,
    browserContextId: "default",
  };
}
