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
  type TargetState,
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

interface ConnectionSettings {
  initialLayoutMode: "full" | "off";
  initialUrl: string | null;
  debug: boolean;
  cdpDebug: boolean;
  idleMs: number;
  maxSessionMs: number;
  isolateCapOverrides: PageIsolateCapOverrides;
  connectionMode: "page" | "browser";
}

function readConnectionSettings(request: Request): ConnectionSettings {
  const defaults: ConnectionSettings = {
    initialLayoutMode: "full",
    initialUrl: null,
    debug: false,
    cdpDebug: false,
    idleMs: IDLE_SESSION_MS,
    maxSessionMs: MAX_SESSION_MS,
    isolateCapOverrides: {},
    connectionMode: "browser",
  };
  let wsUrl: URL;
  try {
    wsUrl = new URL(request.url);
  } catch {
    return defaults;
  }
  const params = wsUrl.searchParams;
  return {
    initialLayoutMode: initialLayoutMode(params),
    initialUrl: initialUrlParam(params),
    debug: enabledParam(params, "debug"),
    cdpDebug: enabledParam(params, "cdpDebug"),
    idleMs: cappedPositiveParam(params, "ksIdleMs", IDLE_SESSION_MS),
    maxSessionMs: cappedPositiveParam(params, "ksMaxSessionMs", MAX_SESSION_MS),
    isolateCapOverrides: isolateCapParams(params),
    connectionMode: wsUrl.pathname.startsWith("/devtools/page/") ? "page" : "browser",
  };
}

function initialLayoutMode(params: URLSearchParams): "full" | "off" {
  const mode = params.get("layout");
  return mode === "off" || mode === "0" || mode === "false" ? "off" : "full";
}

function initialUrlParam(params: URLSearchParams): string | null {
  const value = params.get("initialUrl");
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return isHttpUrlProtocol(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function isHttpUrlProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

function enabledParam(params: URLSearchParams, name: string): boolean {
  const value = params.get(name);
  return value === "1" || value === "true";
}

function cappedPositiveParam(params: URLSearchParams, name: string, ceiling: number): number {
  const value = positiveParam(params.get(name));
  return value === undefined ? ceiling : Math.min(ceiling, value);
}

function positiveParam(value: string | null): number | undefined {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isolateCapParams(params: URLSearchParams): PageIsolateCapOverrides {
  const overrides: PageIsolateCapOverrides = {};
  const cpuMs = positiveParam(params.get("ksCpuCapMs"));
  const wallMs = positiveParam(params.get("ksWallCapMs"));
  if (cpuMs !== undefined) overrides.cpuMs = cpuMs;
  if (wallMs !== undefined) overrides.wallMs = wallMs;
  return overrides;
}

interface ConnectionMetrics {
  sendCount: number;
  sendBytesTotal: number;
  sendFailCount: number;
  screencastFramesSent: number;
  screencastFrameBytesSent: number;
  screencastAcksReceived: number;
  wsClosing: boolean;
  memAtClose: ReturnType<typeof engineMemoryBreakdown> | null;
}

interface HandleWebSocketOptions {
  exemptIdleDeadline?: boolean;
  externalOutbound?: ExternalOutbound;
  onDispatch?: (dispatch: (req: CdpRequest) => Promise<CdpResponse>) => void;
  host?: EngineHost;
}

interface ConnectionSession {
  server: WebSocket;
  connectionId: string;
  env: Env;
  ctx: ExecutionContext;
  browser: BrowserState;
  dispatchCtx: DispatchCtx;
  networkEvents: NetworkEventTracker;
  analytics: KitesurfAnalytics;
  metrics: ConnectionMetrics;
  rejoinLocalTrace: <R>(fn: () => R) => R;
  arrivalClock: () => number;
  tracedDispatch: (req: CdpRequest) => Promise<CdpResponse>;
  debug: boolean;
}

interface SessionDeadlines {
  sessionOpenedAt: number;
  lastClientMessageAt: number;
  deadlineFired: boolean;
}

interface ConnectionInitialization {
  request: Request;
  env: Env;
  ctx: ExecutionContext;
  server: WebSocket;
  connectionId: string;
  options: ReturnType<typeof resolveConnectionOptions>;
  settings: ConnectionSettings;
  opts?: HandleWebSocketOptions;
}

function createConnectionMetrics(): ConnectionMetrics {
  return {
    sendCount: 0,
    sendBytesTotal: 0,
    sendFailCount: 0,
    screencastFramesSent: 0,
    screencastFrameBytesSent: 0,
    screencastAcksReceived: 0,
    wsClosing: false,
    memAtClose: null,
  };
}

function createConnectionSession(init: ConnectionInitialization): ConnectionSession {
  const { env, ctx, server, connectionId, settings, opts } = init;
  const metrics = createConnectionMetrics();
  const emit = (event: CdpEvent) => sendPayload(server, metrics, event);
  const networkEvents = new NetworkEventTracker(emit, connectionId);
  const analytics = createConnectionAnalytics(init);
  registerTracker(connectionId, networkEvents);
  const requestBlocker = registerConnectionRequestBlocker(connectionId, opts);
  const cookies = createCookieJar();
  registerCookieJar(connectionId, cookies);
  const browser = createBrowserState(init, networkEvents, cookies);
  const dispatchCtx = createDispatchContext(init, browser, analytics, requestBlocker, metrics);
  const tracedDispatch = createTracedDispatch(env, connectionId, dispatchCtx);
  return {
    server,
    connectionId,
    env,
    ctx,
    browser,
    dispatchCtx,
    networkEvents,
    analytics,
    metrics,
    rejoinLocalTrace: localTraceEventWrap(env),
    arrivalClock: makeWallClock(dispatchCtx.env),
    tracedDispatch,
    debug: settings.debug,
  };
}

function createConnectionAnalytics(init: ConnectionInitialization): KitesurfAnalytics {
  const { request, env, ctx, connectionId, options, settings, opts } = init;
  return new KitesurfAnalytics(
    {
      sessionId: connectionId,
      entrypoint: options.entrypoint,
      connectionMode: settings.connectionMode,
      environment: nonNullishString(env.KITESURF_ENV),
      buildVersion: nonNullishString(env.KITESURF_VERSION),
      colo: requestColo(request),
    },
    new SafePerformance((env as { HOST_CLOCK?: HostClockTimer }).HOST_CLOCK),
    {
      factory: opts?.host?.telemetry,
      request,
      props: ctx.props,
      env,
      waitUntil: (promise) => ctx.waitUntil(promise),
    },
  );
}

function nonNullishString(value: string | undefined): string {
  return value ?? "";
}

function requestColo(request: Request): string {
  const cloudflare = request.cf as { colo?: string } | undefined;
  return cloudflare?.colo ?? "";
}

function registerConnectionRequestBlocker(
  connectionId: string,
  opts: HandleWebSocketOptions | undefined,
) {
  const requestBlocker = opts?.host?.requestBlocker;
  if (requestBlocker) registerRequestBlocker(connectionId, requestBlocker);
  return requestBlocker;
}

function createBrowserState(
  init: ConnectionInitialization,
  networkEvents: NetworkEventTracker,
  cookies: ReturnType<typeof createCookieJar>,
): BrowserState {
  const { request, env, ctx, settings, opts, options } = init;
  const workerBudget = new DynamicWorkerBudget();
  const browser: BrowserState = {
    targets: new Map(),
    sandboxOutbound: createSandboxOutboundOverride(
      (ctx as ExecutionContext & { exports: SandboxOutboundExports }).exports,
      env,
      opts?.externalOutbound,
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
    layoutMode: settings.initialLayoutMode,
    cdpDebug: settings.cdpDebug,
    isolateCapOverrides: settings.isolateCapOverrides,
    connectionMode: settings.connectionMode,
    ttyKeyboard: false,
    preNavScripts: new Map<string, string>(),
    learnedInsertedScripts: new Map(),
    pendingBindings: new Set<string>(),
    execContextSeq: 3,
    runtimeEnabledSessions: new Set<string>(),
    rendererManager: null,
    workerBudget,
    dedicatedWorkers: new DedicatedWorkers(workerBudget, (promise) => ctx.waitUntil(promise)),
    skipSpeculativeRaster: request.headers.get(SKIP_SPECULATIVE_RASTER_HEADER) === "1",
    skipPartialRaster: env.KITESURF_DISABLE_PARTIAL_RASTER === "1",
    fontDefer: options.fontDefer,
    rendererSessionId: null,
    engineSessionId: null,
    wsClosing: false,
    attributionHeaders: pickHeaders(request, opts?.host?.attributionHeaders),
  };
  browser.workerBudget.countPageTargets = () => countPageTargets(browser);
  return browser;
}

function countPageTargets(browser: BrowserState): number {
  let count = 0;
  for (const target of browser.targets.values()) {
    if (target.type !== "page") continue;
    if (target.pageScriptLease || target.navigateGeneration > 0) count++;
  }
  return count;
}

function createDispatchContext(
  init: ConnectionInitialization,
  browser: BrowserState,
  analytics: KitesurfAnalytics,
  requestBlocker: ReturnType<typeof registerConnectionRequestBlocker>,
  metrics: ConnectionMetrics,
): DispatchCtx {
  const { env, ctx, connectionId, opts } = init;
  return {
    browser,
    emit: (event) => sendPayload(init.server, metrics, event),
    commandExtension: opts?.host?.createCdpCommandExtension?.(env),
    requestBlocker,
    env: buildDispatchEnv(env),
    ctx,
    connectionId,
    analytics,
  };
}

function createTracedDispatch(
  env: Env,
  connectionId: string,
  dispatchCtx: DispatchCtx,
): ConnectionSession["tracedDispatch"] {
  return (req) =>
    NOISY_CDP_METHODS.has(req.method)
      ? dispatch(dispatchCtx, req)
      : traceSpan(env.HOST_TRACER, "cdp." + req.method, () => dispatch(dispatchCtx, req), {
          connectionId,
        });
}

function trackSocketLifetime(server: WebSocket, ctx: ExecutionContext): void {
  const lifetime = new Promise<void>((resolve) => {
    server.addEventListener("close", () => resolve());
    server.addEventListener("error", () => resolve());
  });
  ctx.waitUntil(lifetime);
}

function announceInitialTargets(session: ConnectionSession): void {
  ensureBrowserTarget(session.dispatchCtx);
  const initialPage = createPageTarget(session.dispatchCtx, "about:blank");
  session.dispatchCtx.emit({
    method: "Target.targetCreated",
    params: { targetInfo: { ...visibleInfo(initialPage, session.browser.connectionMode) } },
  });
}

function notifyDispatchConsumers(
  session: ConnectionSession,
  onCtx: ((dispatchCtx: DispatchCtx) => void) | undefined,
  onDispatch: HandleWebSocketOptions["onDispatch"],
): void {
  try {
    onCtx?.(session.dispatchCtx);
    onDispatch?.(session.tracedDispatch);
  } catch (error) {
    console.warn("[kitesurf-ws] in-process consumer threw:", error);
  }
}

function openSessionDeadlines(): SessionDeadlines {
  const sessionOpenedAt = Date.now();
  return {
    sessionOpenedAt,
    lastClientMessageAt: sessionOpenedAt,
    deadlineFired: false,
  };
}

function registerBackgroundDrain(
  session: ConnectionSession,
  deadlines: SessionDeadlines,
  settings: ConnectionSettings,
  exemptIdleDeadline: boolean,
): void {
  const drainTimer = setInterval(
    () => drainBackgroundEvents(session, deadlines, settings, exemptIdleDeadline),
    BACKGROUND_EVENT_DRAIN_INTERVAL_MS,
  );
  const cleanup = () => clearInterval(drainTimer);
  session.ctx.waitUntil(
    new Promise<void>((resolve) => {
      const finish = () => {
        cleanup();
        resolve();
      };
      session.server.addEventListener("close", finish, { once: true });
      session.server.addEventListener("error", finish, { once: true });
    }),
  );
}

function drainBackgroundEvents(
  session: ConnectionSession,
  deadlines: SessionDeadlines,
  settings: ConnectionSettings,
  exemptIdleDeadline: boolean,
): void {
  if (closeIfExpired(session, deadlines, settings, exemptIdleDeadline)) return;
  if (session.browser.targets.size === 0) return;
  session.networkEvents.drain();
  drainInterception(session.connectionId);
  for (const target of session.browser.targets.values()) {
    pumpBackgroundEvents(session.dispatchCtx, target);
  }
}

function closeIfExpired(
  session: ConnectionSession,
  deadlines: SessionDeadlines,
  settings: ConnectionSettings,
  exemptIdleDeadline: boolean,
): boolean {
  if (deadlines.deadlineFired || session.metrics.wsClosing) return deadlines.deadlineFired;
  const reason = sessionDeadlineReason(deadlines, settings, exemptIdleDeadline, Date.now());
  if (reason === null) return false;
  deadlines.deadlineFired = true;
  console.warn(`[kitesurf-ws] closing session ${session.connectionId}: ${reason}`);
  closeSocketForDeadline(session.server, reason);
  return true;
}

function sessionDeadlineReason(
  deadlines: SessionDeadlines,
  settings: ConnectionSettings,
  exemptIdleDeadline: boolean,
  now: number,
): string | null {
  if (now - deadlines.sessionOpenedAt > settings.maxSessionMs) {
    return `kitesurf: session exceeded ${settings.maxSessionMs} ms`;
  }
  if (!exemptIdleDeadline && now - deadlines.lastClientMessageAt > settings.idleMs) {
    return `kitesurf: idle for ${settings.idleMs} ms with no client CDP traffic`;
  }
  return null;
}

function closeSocketForDeadline(server: WebSocket, reason: string): void {
  try {
    server.close(1001, reason);
  } catch {}
}

function startInitialNavigation(session: ConnectionSession, initialUrl: string | null): void {
  if (initialUrl === null) return;
  void navigateToInitialUrl(session, initialUrl);
}

async function navigateToInitialUrl(session: ConnectionSession, initialUrl: string): Promise<void> {
  const syntheticReq: CdpRequest = {
    id: -1,
    method: "Page.navigate",
    params: { url: initialUrl },
  };
  try {
    const response = await session.tracedDispatch(syntheticReq);
    if (session.debug) {
      console.log("[cdp auto-navigate]", initialUrl, "->", JSON.stringify(response));
    }
  } catch (error) {
    console.error("[cdp auto-navigate threw]", error);
  }
}

function installSocketListeners(session: ConnectionSession, deadlines: SessionDeadlines): void {
  session.server.addEventListener("message", (event) => onSocketMessage(session, deadlines, event));
  session.server.addEventListener("close", (event) => onSocketClose(session, event));
  session.server.addEventListener("error", (event) => onSocketError(session, event));
  session.server.addEventListener("close", (event) => logSocketClose(session, event));
}

function onSocketMessage(
  session: ConnectionSession,
  deadlines: SessionDeadlines,
  event: MessageEvent,
): void {
  const arrivedAt = session.arrivalClock();
  deadlines.lastClientMessageAt = Date.now();
  void session.rejoinLocalTrace(() => processSocketMessage(session, event, arrivedAt));
}

async function processSocketMessage(
  session: ConnectionSession,
  event: MessageEvent,
  arrivedAt: number,
): Promise<void> {
  const parsed = parseCdpRequest(socketMessageText(event.data));
  if (!parsed.ok) {
    sendPayload(session.server, session.metrics, parsed.error);
    return;
  }
  await processCdpRequest(session, parsed.request, arrivedAt);
}

function socketMessageText(data: unknown): string {
  return typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
}

async function processCdpRequest(
  session: ConnectionSession,
  req: CdpRequest,
  arrivedAt: number,
): Promise<void> {
  markArrival(req, arrivedAt);
  logIncomingRequest(session, req);
  countScreencastAck(session.metrics, req);
  await dispatchCdpRequest(session, req);
}

function logIncomingRequest(session: ConnectionSession, req: CdpRequest): void {
  if (!session.debug || NOISY_CDP_METHODS.has(req.method)) return;
  console.log(
    "[cdp <-]",
    req.id,
    req.method,
    req.sessionId ? `(s=${req.sessionId.slice(0, CDP_DEBUG_SESSION_ID_PREFIX_CHARS)})` : "",
  );
}

function countScreencastAck(metrics: ConnectionMetrics, req: CdpRequest): void {
  if (req.method === "Page.screencastFrameAck") metrics.screencastAcksReceived++;
}

async function dispatchCdpRequest(session: ConnectionSession, req: CdpRequest): Promise<void> {
  try {
    const response = await session.tracedDispatch(req);
    logSuccessfulResponse(session, req);
    sendPayload(session.server, session.metrics, response);
  } catch (error) {
    console.error("[cdp dispatch threw]", req.method, error);
    sendPayload(session.server, session.metrics, {
      id: req.id,
      error: { code: -32000, message: String(error) },
      sessionId: req.sessionId,
    });
  }
}

function logSuccessfulResponse(session: ConnectionSession, req: CdpRequest): void {
  if (session.debug && !NOISY_CDP_METHODS.has(req.method)) {
    console.log("[cdp ->]", req.id, req.method, "ok");
  }
}

function onSocketClose(session: ConnectionSession, event: Event): void {
  const closeEvent = event as CloseEvent;
  emitSessionEnd(session.analytics, {
    endReason: "close",
    closeCode: closeEvent.code ?? 0,
    wasClean: closeEvent.wasClean ? 1 : 0,
  });
  session.metrics.wsClosing = true;
  session.browser.wsClosing = true;
  closeSessionResources(session);
}

function closeSessionResources(session: ConnectionSession): void {
  stopConnectionStreams(session.browser);
  disposeConnectionRenderer(session.browser);
  unregisterTracker(session.connectionId);
  session.metrics.memAtClose = engineMemoryBreakdown(session.browser);
  session.networkEvents.dispose();
  unregisterOutboundFilters(session.connectionId);
  unregisterRequestBlocker(session.connectionId);
  unregisterInterception(session.connectionId);
  disposeWebMcpConnection(session.connectionId);
  unregisterConnectionCookieJars(session.connectionId, session.browser.contexts.keys());
  dropConnectionImages(session.connectionId);
  session.browser.dedicatedWorkers.terminateAll("engine WS closed");
  retireConnectionTargets(session);
  session.rejoinLocalTrace(() => endLocalTraceSession(session.env));
}

function stopConnectionStreams(browser: BrowserState): void {
  stopSceneStreams(browser);
  for (const state of browser.screencasts.values()) state.stopped = true;
  browser.screencasts.clear();
}

function disposeConnectionRenderer(browser: BrowserState): void {
  if (browser.rendererManager) {
    try {
      browser.rendererManager.dispose("engine WS closed");
    } catch {}
    browser.rendererManager = null;
  }
}

function retireConnectionTargets(session: ConnectionSession): void {
  for (const target of session.browser.targets.values()) {
    retireConnectionTarget(session, target);
  }
}

function retireConnectionTarget(session: ConnectionSession, target: TargetState): void {
  void cancelAndRemoveTargetWheelQueues(session.browser, target.targetId);
  teardownOopifStubs(target, "engine WS closed");
  void retireStub(target, "wsClosed", "engine WS closed", {
    budget: session.browser.workerBudget,
    waitUntil: (promise) => session.ctx.waitUntil(promise),
  });
  releaseAllDomHandles(target);
}

function onSocketError(session: ConnectionSession, event: Event): void {
  const errorEvent = event as ErrorEvent & {
    error?: { name?: string; message?: string; stack?: string };
  };
  const message = socketErrorMessage(errorEvent);
  const postClose = session.metrics.wsClosing && message.includes("Network connection lost");
  if (!session.metrics.wsClosing) {
    emitSessionEnd(session.analytics, { endReason: "error", closeCode: 0, wasClean: 0 });
  }
  logSocketError(errorEventDetail(errorEvent, session.metrics), postClose);
}

function socketErrorMessage(event: ErrorEvent & { error?: { message?: string } }): string {
  return event.error?.message ?? event.message ?? "";
}

function errorEventDetail(
  event: ErrorEvent & { error?: { name?: string; message?: string; stack?: string } },
  metrics: ConnectionMetrics,
) {
  return {
    message: event.message,
    type: event.type,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error_name: event.error?.name,
    error_message: event.error?.message,
    counters: {
      sendCount: metrics.sendCount,
      sendBytesTotal: metrics.sendBytesTotal,
      sendFailCount: metrics.sendFailCount,
      screencastFramesSent: metrics.screencastFramesSent,
      screencastFrameBytesSent: metrics.screencastFrameBytesSent,
      screencastAcksReceived: metrics.screencastAcksReceived,
    },
  };
}

function logSocketError(detail: ReturnType<typeof errorEventDetail>, postClose: boolean): void {
  if (postClose) {
    console.log(`[kitesurf-ws] post-close async settled: ${JSON.stringify(detail)}`);
  } else {
    console.error(`[kitesurf-ws] error: ${JSON.stringify(detail)}`);
  }
}

function logSocketClose(session: ConnectionSession, event: Event): void {
  const closeEvent = event as CloseEvent;
  const memory = session.metrics.memAtClose ?? engineMemoryBreakdown(session.browser);
  console.log(
    `[kitesurf-ws] close: code=${closeEvent.code} reason="${closeEvent.reason}" wasClean=${closeEvent.wasClean} ` +
      `sendCount=${session.metrics.sendCount} sendBytesTotal=${session.metrics.sendBytesTotal} ` +
      `sendFailCount=${session.metrics.sendFailCount} ` +
      `screencastFramesSent=${session.metrics.screencastFramesSent} ` +
      `screencastFrameBytesSent=${session.metrics.screencastFrameBytesSent} ` +
      `screencastAcksReceived=${session.metrics.screencastAcksReceived} ` +
      `engineWasmBytes=${memory.wasmBytes} ` +
      `engineWasmDeltaBytes=${memory.wasmDeltaBytes} ` +
      `retainedBodyBytes=${memory.retainedBodyBytes} ` +
      `retainedBodyBytesIsolate=${memory.retainedBodyBytesIsolate} ` +
      `retainedRequestCount=${memory.retainedRequestCount} ` +
      `retainedImageBytes=${memory.retainedImageBytes} ` +
      `retainedImageCount=${memory.retainedImageCount} ` +
      `fontAssetCacheBytes=${memory.fontAssetCacheBytes} ` +
      `engineAccountedBytes=${memory.accountedBytes}`,
  );
}
function sendPayload(server: WebSocket, metrics: ConnectionMetrics, payload: unknown): void {
  if (metrics.wsClosing) {
    metrics.sendFailCount++;
    return;
  }
  try {
    const serialized = JSON.stringify(payload);
    recordScreencastSend(metrics, payload, serialized);
    server.send(serialized);
    metrics.sendCount++;
    metrics.sendBytesTotal += serialized.length;
  } catch (error) {
    reportSendFailure(metrics, error);
  }
}

function recordScreencastSend(
  metrics: ConnectionMetrics,
  payload: unknown,
  serialized: string,
): void {
  if (
    !payload ||
    typeof payload !== "object" ||
    (payload as { method?: string }).method !== "Page.screencastFrame"
  ) {
    return;
  }
  metrics.screencastFramesSent++;
  metrics.screencastFrameBytesSent += serialized.length;
  if (metrics.screencastFramesSent % 5 === 1) {
    console.log(
      `[kitesurf-ws] screencastFrame #${metrics.screencastFramesSent} ` +
        `bytes=${serialized.length} totalBytes=${metrics.screencastFrameBytesSent} ` +
        `acksReceived=${metrics.screencastAcksReceived}`,
    );
  }
}

function reportSendFailure(metrics: ConnectionMetrics, error: unknown): void {
  metrics.sendFailCount++;
  const detail = sendFailureDetail(error);
  console.error(
    `[kitesurf-ws] send failed (#${metrics.sendFailCount}, ` +
      `sendCount=${metrics.sendCount}, totalBytes=${metrics.sendBytesTotal}): ${detail}`,
  );
}

function sendFailureDetail(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (isMessageError(error)) return `${error.name ?? "Error"}: ${error.message ?? ""}`;
  return String(error);
}

function isMessageError(error: unknown): error is { name?: string; message?: string } {
  return typeof error === "object" && error !== null && "message" in error;
}

/**
 * Accepts a CDP WebSocket request and returns a 101 response with its session ID.
 * `ctx.waitUntil` keeps connection state alive until the socket closes or errors.
 */
export async function handleWebSocket(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  onCtx?: (dispatchCtx: DispatchCtx) => void,
  opts?: HandleWebSocketOptions,
): Promise<Response> {
  // Also used as the analytics session ID and log correlation key.
  const connectionId = nanoid(CDP_CONNECTION_ID_LENGTH);
  const options = resolveConnectionOptions(request, connectionId, opts?.host);
  const settings = readConnectionSettings(request);

  // External sessions provide their outbound policy before dispatch; regular
  // WebSocket upgrades use the default policy.

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

  server.accept();
  // The WebSocket owns this closure's state; keep the invocation alive until close or error.
  trackSocketLifetime(server, ctx);
  const session = createConnectionSession({
    request,
    env,
    ctx,
    server,
    connectionId,
    options,
    settings,
    opts,
  });
  notifyDispatchConsumers(session, onCtx, opts?.onDispatch);
  announceInitialTargets(session);
  const deadlines = openSessionDeadlines();
  registerBackgroundDrain(session, deadlines, settings, opts?.exemptIdleDeadline === true);
  startInitialNavigation(session, settings.initialUrl);
  installSocketListeners(session, deadlines);

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
