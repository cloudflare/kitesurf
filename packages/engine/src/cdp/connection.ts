// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A BrowserSession owns one browser; a ClientConnection owns one CDP WebSocket that drives it.

import { nanoid } from "nanoid";
import {
  dispatch,
  releaseClientOverrides,
  type DispatchCtx,
  type SessionContext,
} from "./dispatch.ts";
import { traceSpan } from "../tracing.ts";
import { endLocalTraceSession, localTraceEventWrap } from "../tracing-local.ts";
import {
  SKIP_SPECULATIVE_RASTER_HEADER,
  parseCdpRequest,
  type BrowserState,
  type CdpClientState,
  type CdpEvent,
  type CdpRequest,
  type CdpResponse,
  type CdpSuccess,
  type TargetState,
  RawJsonResult,
} from "./types.ts";
import {
  childFrameTargets,
  createPageTarget,
  detachClientSession,
  engineMemoryBreakdown,
  ensureBrowserTarget,
  frameTargetInfo,
} from "./target.ts";
import { pumpBackgroundEvents, teardownOopifStubs } from "./page.ts";
import { retireStub } from "./page-script-generation.ts";
import { releaseAllDomHandles } from "./dom-release.ts";
import { cancelAndRemoveTargetWheelQueues, stopAndRemoveWheelQueue } from "./wheel-queue.ts";
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
import { unregisterIsolateLimitListenersFor } from "../eval/limit-registry.ts";
import type { ExternalOutbound } from "../eval/external-outbound.ts";
import { createSandboxOutboundOverride, type SandboxOutboundExports } from "../eval/outbound.ts";
import { unregisterOutboundFilters } from "./outbound-filter-registry.ts";
import { registerRequestBlocker, unregisterRequestBlocker } from "../request-blocker.ts";
import {
  disableInterceptionForClient,
  unregisterInterception,
  drainInterception,
} from "./fetch-interception.ts";
import {
  KitesurfAnalytics,
  SafePerformance,
  SESSION_ID_HEADER,
  emitSessionEnd,
  type HostClockTimer,
  type SessionEndFields,
} from "../observability.ts";
import { resolveConnectionOptions, type EngineHost } from "../host.ts";
import type { PageIsolateCapOverrides } from "../eval/page-script.ts";
import { buildDispatchEnv } from "./dispatch-env.ts";
import { markArrival } from "./arrival.ts";
import { StyleCache } from "./style-cache.ts";
import { makeWallClock } from "../eval/host-clock.ts";
import { LocalStorage } from "../state/local-storage.ts";
import { MemorySessionStore } from "../state/session-store.ts";
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
const CDP_CLIENT_ID_LENGTH = 8;
const CDP_DEBUG_SESSION_ID_PREFIX_CHARS = 6;

function isRawJsonSuccess(payload: unknown): payload is CdpSuccess & { result: RawJsonResult } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const id: unknown = Reflect.get(payload, "id");
  const sessionId: unknown = Reflect.get(payload, "sessionId");
  return (
    typeof id === "number" &&
    (sessionId === undefined || typeof sessionId === "string") &&
    !Reflect.has(payload, "error") &&
    Reflect.get(payload, "result") instanceof RawJsonResult
  );
}

export function registerDispatchConsumer(
  onDispatch: ((dispatch: (req: CdpRequest) => Promise<CdpResponse>) => void) | undefined,
  tracedDispatch: (req: CdpRequest) => Promise<CdpResponse>,
): void {
  onDispatch?.(async (req) => {
    const response = await tracedDispatch(req);
    if (!isRawJsonSuccess(response)) return response;
    const result = response.result.parse();
    return { ...response, result };
  });
}

export function serializeCdpPayload(payload: unknown): string {
  if (!isRawJsonSuccess(payload)) {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) throw new TypeError("CDP payload is not JSON serializable");
    return serialized;
  }
  // `result` may be a streamed page; join its JSON pieces instead of building the object first.
  const sessionField =
    payload.sessionId === undefined ? "" : ',"sessionId":' + JSON.stringify(payload.sessionId);
  return [
    '{"id":',
    JSON.stringify(payload.id),
    ',"result":',
    ...payload.result.pieces,
    sessionField,
    "}",
  ].join("");
}

/** Options read from a CDP upgrade URL. A malformed URL keeps the defaults. */
export interface ConnectionParams {
  connectionMode: "page" | "browser";
  layoutMode: "full" | "off";
  // From the `/?url=` inspector redirect: navigate without the user entering the URL.
  initialUrl: string | null;
  debug: boolean;
  cdpDebug: boolean;
  // Lower-only: the URL can shorten a deadline but never extend it.
  idleMs: number;
  maxSessionMs: number;
  isolateCapOverrides: PageIsolateCapOverrides;
}

export function parseConnectionParams(request: Request): ConnectionParams {
  const params: ConnectionParams = {
    connectionMode: "browser",
    layoutMode: "full",
    initialUrl: null,
    debug: false,
    cdpDebug: false,
    idleMs: IDLE_SESSION_MS,
    maxSessionMs: MAX_SESSION_MS,
    isolateCapOverrides: {},
  };
  try {
    const wsUrl = new URL(request.url);
    if (wsUrl.pathname.startsWith("/devtools/page/")) {
      params.connectionMode = "page";
    }
    const param = wsUrl.searchParams.get("layout");
    if (param === "off" || param === "0" || param === "false") {
      params.layoutMode = "off";
    }
    const iu = wsUrl.searchParams.get("initialUrl");
    if (iu) {
      try {
        const parsed = new URL(iu);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") {
          params.initialUrl = parsed.toString();
        }
      } catch {}
    }
    const dbg = wsUrl.searchParams.get("debug");
    if (dbg === "1" || dbg === "true") {
      params.debug = true;
    }
    const cdpDbg = wsUrl.searchParams.get("cdpDebug");
    if (cdpDbg === "1" || cdpDbg === "true") {
      params.cdpDebug = true;
    }
    const cpuCapRaw = Number.parseInt(wsUrl.searchParams.get("ksCpuCapMs") ?? "", 10);
    if (Number.isFinite(cpuCapRaw) && cpuCapRaw > 0) {
      params.isolateCapOverrides.cpuMs = cpuCapRaw;
    }
    const wallCapRaw = Number.parseInt(wsUrl.searchParams.get("ksWallCapMs") ?? "", 10);
    if (Number.isFinite(wallCapRaw) && wallCapRaw > 0) {
      params.isolateCapOverrides.wallMs = wallCapRaw;
    }
    const idleRaw = Number.parseInt(wsUrl.searchParams.get("ksIdleMs") ?? "", 10);
    if (Number.isFinite(idleRaw) && idleRaw > 0) {
      params.idleMs = Math.min(params.idleMs, idleRaw);
    }
    const maxSessionRaw = Number.parseInt(wsUrl.searchParams.get("ksMaxSessionMs") ?? "", 10);
    if (Number.isFinite(maxSessionRaw) && maxSessionRaw > 0) {
      params.maxSessionMs = Math.min(params.maxSessionMs, maxSessionRaw);
    }
  } catch {}
  return params;
}

export interface BrowserSessionOptions {
  // A persistent session outlives its clients: one leaving takes only its own state, and the
  // session ends on Browser.close, the wall-clock cap or dispose(). Otherwise the session ends
  // when its one client leaves.
  persistent?: boolean;
  host?: EngineHost;
  externalOutbound?: ExternalOutbound;
  // The host's egress for this session. Called once, and only without an external outbound.
  egress?: () => ExternalOutbound | undefined;
  // A client left a persistent session that keeps running; `remaining` clients are connected.
  onClientLeft?: (remaining: number) => void;
}

export interface ClientOptions {
  // Exempts the client from the idle deadline only; the session's wall-clock cap still applies.
  exemptIdleDeadline?: boolean;
  onCtx?: (dispatchCtx: DispatchCtx) => void;
  onDispatch?: (dispatch: (req: CdpRequest) => Promise<CdpResponse>) => void;
}

/**
 * One browser and everything its clients share: targets, cookie jars, the network log, the
 * renderer, the background drain, the wall-clock cap and teardown. Events go through `route`.
 */
export class BrowserSession {
  // Also the analytics session ID, the log correlation key and the key of every
  // module-scoped registry (network tracker, cookie jars, interception, images).
  readonly id = nanoid(CDP_CONNECTION_ID_LENGTH);
  readonly browser: BrowserState;
  readonly analytics: KitesurfAnalytics;
  // WebSocket events lose the local trace context; handlers rejoin the one captured here.
  readonly rejoinLocalTrace: ReturnType<typeof localTraceEventWrap>;
  readonly arrivalClock: () => number;
  // Engine memory at teardown, for each client's close line.
  memAtClose: ReturnType<typeof engineMemoryBreakdown> | null = null;
  readonly #env: Env;
  readonly #ctx: SessionContext;
  readonly #dispatchEnv: DispatchCtx["env"];
  readonly #persistent: boolean;
  readonly #maxSessionMs: number;
  readonly #onClientLeft: BrowserSessionOptions["onClientLeft"];
  readonly #commandExtension: DispatchCtx["commandExtension"];
  readonly #requestBlocker: DispatchCtx["requestBlocker"];
  // Insertion order is connection order.
  readonly #clients = new Map<string, ClientConnection>();
  // Acts for no client: drains a persistent session while no client is connected.
  readonly #idleCtx: DispatchCtx;
  // The first client opened the browser and its initial page.
  #opened = false;
  readonly #openedAt: number;
  readonly #drainTimer: ReturnType<typeof setInterval>;
  #deadlineFired = false;
  // A non-persistent session whose client idled out: the drain stops while the socket closes.
  #idleClosed = false;
  #disposed = false;

  constructor(
    request: Request,
    env: Env,
    ctx: SessionContext,
    params: ConnectionParams,
    opts: BrowserSessionOptions = {},
  ) {
    this.#env = env;
    this.#ctx = ctx;
    this.#persistent = opts.persistent === true;
    this.#maxSessionMs = params.maxSessionMs;
    this.#onClientLeft = opts.onClientLeft;
    const connectionId = this.id;
    const options = resolveConnectionOptions(request, connectionId, opts.host, env);

    // Retain response bodies only when Network.enable requests buffering.
    const networkEvents = new NetworkEventTracker((event) => this.route(event), connectionId);

    this.analytics = new KitesurfAnalytics(
      {
        sessionId: connectionId,
        entrypoint: options.entrypoint,
        connectionMode: params.connectionMode,
        environment: env.KITESURF_ENV ?? "",
        buildVersion: env.KITESURF_VERSION ?? "",
        colo: (request.cf as { colo?: string } | undefined)?.colo ?? "",
      },
      new SafePerformance((env as { HOST_CLOCK?: HostClockTimer }).HOST_CLOCK),
      {
        factory: opts.host?.telemetry,
        request,
        props: ctx.props,
        env,
        waitUntil: (p) => ctx.waitUntil(p),
      },
    );

    registerTracker(connectionId, networkEvents);
    const requestBlocker = opts.host?.requestBlocker;
    if (requestBlocker) registerRequestBlocker(connectionId, requestBlocker);
    this.#requestBlocker = requestBlocker;

    const cookies = createCookieJar();
    registerCookieJar(connectionId, cookies);
    const workerBudget = new DynamicWorkerBudget();
    const browser: BrowserState = {
      targets: new Map(),
      sandboxOutbound: createSandboxOutboundOverride(
        (ctx as SessionContext & { exports: SandboxOutboundExports }).exports,
        env,
        opts.externalOutbound,
        opts.externalOutbound ? undefined : opts.egress?.(),
      ),
      contexts: new Map(),
      localStorage: new LocalStorage(new MemorySessionStore()),
      nextBrowserContextId: 1,
      cookies,
      screencasts: new Map(),
      styleCache: new StyleCache(),
      imageCache: new Map(),
      networkEvents,
      layoutMode: params.layoutMode,
      cdpDebug: params.cdpDebug,
      isolateCapOverrides: params.isolateCapOverrides,
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
      fontProfile: options.fontProfile,
      wsClosing: false,
      attributionHeaders: pickHeaders(request, opts.host?.attributionHeaders),
    };
    this.browser = browser;

    browser.workerBudget.countPageTargets = () => {
      let n = 0;
      for (const t of browser.targets.values()) {
        if (t.type !== "page") continue;
        if (t.pageScriptLease || t.navigateGeneration > 0) n += 1;
      }
      return n;
    };

    // Host bindings belong to the session's lifetime, not a worker-global cache.
    this.#commandExtension = opts.host?.createCdpCommandExtension?.(env);
    this.#dispatchEnv = buildDispatchEnv(env);
    this.#idleCtx = this.makeCtx(newClientState(params.connectionMode, ""));

    this.#openedAt = Date.now();
    this.rejoinLocalTrace = localTraceEventWrap(env);
    this.arrivalClock = makeWallClock(this.#dispatchEnv);
    this.#drainTimer = setInterval(() => this.#tick(), BACKGROUND_EVENT_DRAIN_INTERVAL_MS);
  }

  get persistent(): boolean {
    return this.#persistent;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  /** Opens the browser with one blank page for the first client; null for every later one. */
  openInitialPage(ctx: DispatchCtx): TargetState | null {
    if (this.#opened) return null;
    this.#opened = true;
    ensureBrowserTarget(ctx);
    return createPageTarget(ctx, "about:blank");
  }

  /** A dispatch context that acts for `client`. Its events go through `route`. */
  makeCtx(client: CdpClientState): DispatchCtx {
    return {
      browser: this.browser,
      emit: (event) => this.route(event),
      commandExtension: this.#commandExtension,
      requestBlocker: this.#requestBlocker,
      env: this.#dispatchEnv,
      ctx: this.#ctx,
      connectionId: this.id,
      analytics: this.analytics,
      client,
      emitToClient: (event) => {
        if (!this.#disposed) this.#clients.get(client.id)?.deliver(event);
      },
      peers: () => Array.from(this.#clients.values(), (c) => c.ctx),
    };
  }

  // Delivers an event. A non-persistent session sends everything to its one client. A
  // persistent one sends an event on a CDP session to the client that owns it, and drops it
  // when no client does; root-session events go to every client.
  route(event: CdpEvent): void {
    if (this.#disposed) return;
    const sessionId = addressedSession(event);
    if (!this.#persistent || sessionId === undefined) {
      for (const c of this.#clients.values()) c.deliver(event);
    } else {
      for (const c of this.#clients.values()) {
        if (c.state.sessions.has(sessionId)) c.deliver(event);
      }
    }
    if (event.method === "Target.detachedFromTarget" && sessionId !== undefined) {
      for (const c of this.#clients.values()) c.state.sessions.delete(sessionId);
    }
  }

  /** Connects a CDP client on an accepted server-side socket. */
  attachClient(
    server: WebSocket,
    params: ConnectionParams,
    opts: ClientOptions = {},
  ): ClientConnection {
    if (this.#disposed) throw new Error("browser session has ended");
    if (!this.#persistent && this.#clients.size > 0) {
      throw new Error("browser session already has a client");
    }
    const client = new ClientConnection(this, server, params, opts, {
      onLeave: (c, end) => this.#clientLeft(c, end),
      onLateDispatch: (c) => {
        if (this.#persistent && !this.#disposed) this.#releaseClient(c);
      },
    });
    this.#clients.set(client.state.id, client);
    client.start();
    return client;
  }

  #clientLeft(client: ClientConnection, end: SessionEndFields): void {
    this.#clients.delete(client.state.id);
    if (!this.#persistent) {
      this.dispose(end);
      return;
    }
    if (this.#disposed) return;
    this.#releaseClient(client);
    try {
      this.#onClientLeft?.(this.#clients.size);
    } catch (err) {
      console.warn("[kitesurf-ws] onClientLeft threw:", err);
    }
  }

  // Undoes what a departed client held on a session that keeps running: its CDP sessions and
  // their domain enables, its screencasts, new-document scripts and Fetch interception. Safe
  // to repeat, for a command that was still running when the client left.
  #releaseClient(client: ClientConnection): void {
    const browser = this.browser;
    const state = client.state;
    for (const id of state.preNavScriptIds) browser.preNavScripts.delete(id);
    state.preNavScriptIds.clear();
    for (const [targetId, stream] of Array.from(browser.screencasts)) {
      if (stream.ownerClientId !== state.id) continue;
      stream.stopped = true;
      stream.wake?.();
      browser.screencasts.delete(targetId);
      stopAndRemoveWheelQueue(browser, targetId, stream.ownerSessionId, stream.wheelQueue);
    }
    for (const sessionId of Array.from(state.sessions)) {
      detachClientSession(client.ctx, sessionId);
      browser.runtimeEnabledSessions.delete(sessionId);
      for (const t of browser.targets.values()) {
        t.debuggerEnabledSessions.delete(sessionId);
        t.domEnabledSessions.delete(sessionId);
        t.cssEnabledSessions.delete(sessionId);
      }
    }
    state.sessions.clear();
    state.memoryTargets.renderer = null;
    state.memoryTargets.engine = null;
    disableInterceptionForClient(this.id, state.id);
    releaseClientOverrides(client.ctx, state.id);
  }

  /** Closes every client and ends the session. */
  close(code: number, reason: string): void {
    for (const c of Array.from(this.#clients.values())) c.close(code, reason);
    this.dispose({ endReason: "close", closeCode: code, wasClean: 1 });
  }

  // Returns true from the tick on which the wall-clock cap fires, and on every later one.
  #closeIfExpired(): boolean {
    if (this.#deadlineFired || this.#disposed) return this.#deadlineFired;
    if (Date.now() - this.#openedAt <= this.#maxSessionMs) return false;
    this.#deadlineFired = true;
    const reason = `kitesurf: session exceeded ${this.#maxSessionMs} ms`;
    console.warn(`[kitesurf-ws] closing session ${this.id}: ${reason}`);
    for (const c of Array.from(this.#clients.values())) c.close(1001, reason);
    if (this.#persistent) this.dispose({ endReason: "close", closeCode: 1001, wasClean: 1 });
    return true;
  }

  #tick(): void {
    // Once the client idles out, the wall-clock cap must not close its socket a second time.
    if (this.#idleClosed || this.#closeIfExpired()) return;
    for (const c of Array.from(this.#clients.values())) {
      if (c.closeIfIdle() && !this.#persistent) this.#idleClosed = true;
    }
    if (this.#idleClosed) return;
    const ctx = this.#clients.values().next().value?.ctx ?? this.#idleCtx;
    const browser = this.browser;
    if (browser.targets.size === 0) return;
    browser.networkEvents.drain();
    drainInterception(this.id);
    for (const t of browser.targets.values()) {
      pumpBackgroundEvents(ctx, t);
    }
  }

  /** Ends the session: emits session_end, retires every isolate and sweeps the registries. */
  dispose(end: SessionEndFields): void {
    if (this.#disposed) return;
    const browser = this.browser;
    emitSessionEnd(this.analytics, {
      ...end,
      workerLeases: end.workerLeases ?? browser.workerBudget.snapshot(),
    });
    this.#disposed = true;
    clearInterval(this.#drainTimer);
    for (const c of Array.from(this.#clients.values())) {
      c.close(1001, "kitesurf: browser session ended");
    }
    this.#clients.clear();
    const connectionId = this.id;
    const ctx = this.#ctx;
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
    this.memAtClose = engineMemoryBreakdown(browser);
    browser.networkEvents.dispose();
    unregisterOutboundFilters(connectionId);
    unregisterRequestBlocker(connectionId);
    unregisterInterception(connectionId);
    disposeWebMcpConnection(connectionId);
    unregisterConnectionCookieJars(connectionId, browser.contexts.keys());
    dropConnectionImages(connectionId);
    unregisterIsolateLimitListenersFor(connectionId);
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
    this.rejoinLocalTrace(() => endLocalTraceSession(this.#env));
  }
}

function newClientState(connectionMode: "page" | "browser", id: string): CdpClientState {
  return {
    id,
    connectionMode,
    autoAttach: false,
    flatten: false,
    sessions: new Set(),
    preNavScriptIds: new Set(),
    memoryTargets: { renderer: null, engine: null },
  };
}

// The session an event belongs to: its own, or the one an attach or detach notice names.
function addressedSession(event: CdpEvent): string | undefined {
  if (event.sessionId) return event.sessionId;
  if (event.method === "Target.attachedToTarget" || event.method === "Target.detachedFromTarget") {
    return event.params.sessionId;
  }
  return undefined;
}

interface ClientHooks {
  // The client is gone. Called once.
  onLeave: (client: ClientConnection, end: SessionEndFields) => void;
  // A command finished after the client left.
  onLateDispatch: (client: ClientConnection) => void;
}

/** One CDP WebSocket on a BrowserSession: sending, the idle deadline and the message loop. */
export class ClientConnection {
  readonly state: CdpClientState;
  readonly ctx: DispatchCtx;
  readonly #session: BrowserSession;
  readonly #server: WebSocket;
  readonly #params: ConnectionParams;
  readonly #opts: ClientOptions;
  readonly #hooks: ClientHooks;
  readonly #tracedDispatch: (req: CdpRequest) => Promise<CdpResponse>;
  #sendCount = 0;
  #sendBytesTotal = 0;
  #sendFailCount = 0;
  #screencastFramesSent = 0;
  #screencastFrameBytesSent = 0;
  #screencastAcksReceived = 0;
  #closing = false;
  // Only client CDP messages renew this; engine activity must not keep an idle client open.
  #lastClientMessageAt = Date.now();
  #deadlineFired = false;
  #left = false;

  constructor(
    session: BrowserSession,
    server: WebSocket,
    params: ConnectionParams,
    opts: ClientOptions,
    hooks: ClientHooks,
  ) {
    this.#session = session;
    this.#server = server;
    this.#params = params;
    this.#opts = opts;
    this.#hooks = hooks;
    this.state = newClientState(params.connectionMode, nanoid(CDP_CLIENT_ID_LENGTH));
    const ctx = session.makeCtx(this.state);
    this.ctx = ctx;
    const connectionId = session.id;
    this.#tracedDispatch = (req: CdpRequest) =>
      NOISY_CDP_METHODS.has(req.method)
        ? dispatch(ctx, req)
        : traceSpan(ctx.env.HOST_TRACER, "cdp." + req.method, () => dispatch(ctx, req), {
            connectionId,
          });
  }

  /** Sends an event or response to this client alone. */
  deliver(payload: unknown): void {
    if (this.#closing) {
      this.#sendFailCount++;
      return;
    }
    try {
      const str = serializeCdpPayload(payload);
      if (
        payload &&
        typeof payload === "object" &&
        (payload as { method?: string }).method === "Page.screencastFrame"
      ) {
        this.#screencastFramesSent++;
        this.#screencastFrameBytesSent += str.length;
        if (this.#screencastFramesSent % 5 === 1) {
          console.log(
            `[kitesurf-ws] screencastFrame #${this.#screencastFramesSent} ` +
              `bytes=${str.length} totalBytes=${this.#screencastFrameBytesSent} ` +
              `acksReceived=${this.#screencastAcksReceived}`,
          );
        }
      }
      this.#server.send(str);
      this.#sendCount++;
      this.#sendBytesTotal += str.length;
    } catch (err) {
      this.#sendFailCount++;
      const msg =
        err instanceof Error
          ? `${err.name}: ${err.message}`
          : err && typeof err === "object" && "message" in err
            ? `${(err as { name?: string }).name ?? "Error"}: ${(err as { message?: string }).message ?? ""}`
            : String(err);
      console.error(
        `[kitesurf-ws] send failed (#${this.#sendFailCount}, ` +
          `sendCount=${this.#sendCount}, totalBytes=${this.#sendBytesTotal}): ${msg}`,
      );
    }
  }

  // Closes the socket. A non-persistent session tears down from the close listener. A
  // persistent one lets the client leave here, so a peer that never answers the close frame
  // cannot hold its sessions open.
  close(code: number, reason: string): void {
    try {
      this.#server.close(code, reason);
    } catch {}
    if (this.#session.persistent) {
      this.#leave({ endReason: "close", closeCode: code, wasClean: 1 });
    }
  }

  // The close listener, close() and a transport error can each report the same departure.
  #leave(end: SessionEndFields): void {
    this.#closing = true;
    if (this.#left) return;
    this.#left = true;
    this.#hooks.onLeave(this, end);
  }

  /** Closes this client once it has sent nothing for its idle budget; true on the closing call. */
  closeIfIdle(): boolean {
    if (this.#deadlineFired || this.#closing) return false;
    if (this.#opts.exemptIdleDeadline === true) return false;
    const idleMs = this.#params.idleMs;
    if (Date.now() - this.#lastClientMessageAt <= idleMs) return false;
    this.#deadlineFired = true;
    const reason = `kitesurf: idle for ${idleMs} ms with no client CDP traffic`;
    console.warn(`[kitesurf-ws] closing session ${this.#session.id}: ${reason}`);
    this.close(1001, reason);
    return true;
  }

  /** Runs the in-process hooks, announces the page targets and starts listening. */
  start(): void {
    const session = this.#session;
    const server = this.#server;
    const params = this.#params;

    try {
      this.#opts.onCtx?.(this.ctx);
      // An in-process consumer's commands never cross `server`, so they must reset the idle clock
      // here or its session closes idleMs after it opened, however busy it is.
      registerDispatchConsumer(this.#opts.onDispatch, (req) => {
        this.#lastClientMessageAt = Date.now();
        return this.#tracedDispatch(req);
      });
    } catch (err) {
      console.warn("[kitesurf-ws] in-process consumer threw:", err);
    }

    // After the hooks: a page a hook creates is announced once, by the command that created
    // it. The first client opens the browser; a later one hears of the pages that exist, and in
    // browser mode of their child frames, as emitFrameTarget told the clients before it.
    const initialPage = session.openInitialPage(this.ctx);
    const announced = initialPage
      ? [initialPage]
      : Array.from(session.browser.targets.values()).filter((t) => t.type === "page");
    for (const t of announced) {
      this.deliver({
        method: "Target.targetCreated",
        params: { targetInfo: { ...visibleInfo(t, params.connectionMode) } },
      });
      if (initialPage || params.connectionMode !== "browser") continue;
      for (const frame of childFrameTargets(t)) {
        this.deliver({
          method: "Target.targetCreated",
          params: { targetInfo: frameTargetInfo(frame) },
        });
      }
    }

    const initialUrl = params.initialUrl;
    if (initialUrl !== null) {
      const syntheticReq: CdpRequest = {
        id: -1,
        method: "Page.navigate",
        params: { url: initialUrl },
      };
      void (async () => {
        try {
          const response = await this.#tracedDispatch(syntheticReq);
          if (params.debug) {
            console.log("[cdp auto-navigate]", initialUrl, "->", JSON.stringify(response));
          }
        } catch (err) {
          console.error("[cdp auto-navigate threw]", err);
        }
      })();
    }

    server.addEventListener("message", (event) => this.#onMessage(event));
    server.addEventListener("close", (ev) => {
      const c = ev as CloseEvent;
      this.#leave({ endReason: "close", closeCode: c.code ?? 0, wasClean: c.wasClean ? 1 : 0 });
      this.#logClose(c);
    });
    server.addEventListener("error", (ev) => this.#onError(ev));
  }

  #onMessage(event: MessageEvent): void {
    // Preserve queue delay for request-boundary timing.
    const arrivedAt = this.#session.arrivalClock();
    const params = this.#params;
    this.#lastClientMessageAt = Date.now();
    void this.#session.rejoinLocalTrace(async () => {
      const parsed = parseCdpRequest(
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer),
      );
      if (!parsed.ok) {
        this.deliver(parsed.error);
        return;
      }
      const req = parsed.request;
      markArrival(req, arrivedAt);

      if (params.debug && !NOISY_CDP_METHODS.has(req.method)) {
        console.log(
          "[cdp <-]",
          req.id,
          req.method,
          req.sessionId ? `(s=${req.sessionId.slice(0, CDP_DEBUG_SESSION_ID_PREFIX_CHARS)})` : "",
        );
      }

      if (req.method === "Page.screencastFrameAck") {
        this.#screencastAcksReceived++;
      }

      try {
        const response = await this.#tracedDispatch(req);
        if (params.debug && !NOISY_CDP_METHODS.has(req.method)) {
          console.log("[cdp ->]", req.id, req.method, "ok");
        }
        this.deliver(response);
        // Chrome exits after it answers Browser.close, which drops the socket. Clients behind
        // a proxy wait for that drop, so `browser.close()` hangs unless the engine closes too.
        if (req.method === "Browser.close" && !("error" in response)) {
          if (this.#session.persistent) this.#session.close(1000, "Browser.close");
          else this.close(1000, "Browser.close");
        }
      } catch (err) {
        console.error("[cdp dispatch threw]", req.method, err);
        this.deliver({
          id: req.id,
          error: { code: -32000, message: String(err) },
          sessionId: req.sessionId,
        });
      }
      if (this.#left) this.#hooks.onLateDispatch(this);
    });
  }

  #onError(ev: Event): void {
    const e = ev as ErrorEvent & {
      error?: { name?: string; message?: string; stack?: string };
    };
    const msg = e.error?.message ?? e.message ?? "";
    const postClose = this.#closing && msg.includes("Network connection lost");
    // workerd may never follow the error with a close event, so the client leaves now. A
    // non-persistent session ends with it.
    if (!this.#closing) this.#leave({ endReason: "error", closeCode: 0, wasClean: 0 });
    const detail = {
      message: e.message,
      type: e.type,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      error_name: e.error?.name,
      error_message: e.error?.message,
      counters: {
        sendCount: this.#sendCount,
        sendBytesTotal: this.#sendBytesTotal,
        sendFailCount: this.#sendFailCount,
        screencastFramesSent: this.#screencastFramesSent,
        screencastFrameBytesSent: this.#screencastFrameBytesSent,
        screencastAcksReceived: this.#screencastAcksReceived,
      },
    };
    if (postClose) {
      console.log(`[kitesurf-ws] post-close async settled: ${JSON.stringify(detail)}`);
    } else {
      console.error(`[kitesurf-ws] error: ${JSON.stringify(detail)}`);
    }
  }

  #logClose(c: CloseEvent): void {
    const session = this.#session;
    const mem = session.memAtClose ?? engineMemoryBreakdown(session.browser);
    console.log(
      `[kitesurf-ws] close: code=${c.code} reason="${c.reason}" wasClean=${c.wasClean} ` +
        `sendCount=${this.#sendCount} sendBytesTotal=${this.#sendBytesTotal} ` +
        `sendFailCount=${this.#sendFailCount} ` +
        `screencastFramesSent=${this.#screencastFramesSent} ` +
        `screencastFrameBytesSent=${this.#screencastFrameBytesSent} ` +
        `screencastAcksReceived=${this.#screencastAcksReceived} ` +
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
  }
}

/**
 * Accepts a CDP WebSocket request and returns a 101 response with its session ID. The session
 * has this one client and ends with its socket; `ctx.waitUntil` keeps it alive until then.
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
  const params = parseConnectionParams(request);

  // Before the socket exists: a host connectionOptions hook that throws fails the upgrade, and
  // leaves no accepted socket whose lifetime promise could never settle. External sessions
  // provide their outbound policy before dispatch; regular upgrades use the default policy.
  const session = new BrowserSession(request, env, ctx, params, {
    host: opts?.host,
    externalOutbound: opts?.externalOutbound,
    egress: () => opts?.host?.egress?.(env, ctx),
  });

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

  server.accept();

  const wsLifetime = new Promise<void>((resolve) => {
    server.addEventListener("close", () => resolve());
    server.addEventListener("error", () => resolve());
  });
  ctx.waitUntil(wsLifetime);

  session.attachClient(server, params, {
    exemptIdleDeadline: opts?.exemptIdleDeadline,
    onCtx,
    onDispatch: opts?.onDispatch,
  });

  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: { [SESSION_ID_HEADER]: session.id },
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
