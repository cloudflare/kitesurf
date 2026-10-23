// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Adapts PageScript RPC calls with per-call timeouts and bounded teardown.

import type {
  KeyEventInit,
  LoadCompletion,
  MouseEventInit,
  OpenSessionInit,
  PageScriptMethod,
  PageScriptReply,
  PageScriptWireParams,
  ReceivedUpstreamParams,
  RetainedPageScriptSession,
  RetainedPageScriptSessionStub,
  SessionOutbound,
  UpstreamMessage,
  WireMeta,
} from "@kitesurf/jsrpc-types/page-script";
import type { QueryDomArgs, QueryDomMethod, QueryDomResult } from "@kitesurf/jsrpc-types/query-dom";
import type { RenderPortStub } from "@kitesurf/jsrpc-types/page-renderer";
import type { PageScriptStub, UpstreamEventHandler } from "./page-script.ts";
import { notifyIsolateLimit } from "./limit-registry.ts";

export type RpcSessionCallable = Pick<RetainedPageScriptSessionStub, "close"> &
  Pick<RetainedPageScriptSession, "call"> & {
    makeRenderPort(): Promise<RenderPortStub>;
    [Symbol.dispose]?: () => void;
  };

export interface RpcSessionEntrypoint {
  openSession(init: OpenSessionInit): Promise<RpcSessionCallable>;
  killIsolate?(reason?: string): Promise<unknown>;
}

export interface PageScriptRpcSessionOptions {
  defaultTimeoutMs?: number;
  outbound?: SessionOutbound;
  wrapOpen?: (open: () => Promise<RpcSessionCallable>) => Promise<RpcSessionCallable>;
  getTraceParent?: () => string | null;
  now?: () => number;
  wallCapMs?: number;
  scriptName?: string;
}

// A delayed loaded-worker wake must not pin teardown indefinitely.
const TEARDOWN_RPC_GRACE_MS = 1_000;

interface InflightCall {
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  method: string;
  settled: boolean;
}

interface PageScriptSessionSettings {
  defaultTimeoutMs: number;
  getTraceParent: (() => string | null) | undefined;
  now: () => number;
  scriptName: string | null;
  wallCapMs: number;
}

function pageScriptSessionSettings(opts: PageScriptRpcSessionOptions): PageScriptSessionSettings {
  return {
    defaultTimeoutMs: opts.defaultTimeoutMs ?? 60_000,
    getTraceParent: opts.getTraceParent,
    now: opts.now ?? (() => Date.now()),
    scriptName: opts.scriptName ?? null,
    wallCapMs: opts.wallCapMs ?? 0,
  };
}

function upstreamParams(message: UpstreamMessage): ReceivedUpstreamParams | null {
  if (!message || typeof message.event !== "string") return null;
  return message.params && typeof message.params === "object" ? message.params : {};
}

function upstreamErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rpcErrorMessage(error: unknown): string {
  return (error as Error)?.message ?? String(error);
}

function shouldIgnoreTransportDeath(dead: boolean, raw: string): boolean {
  return dead || !/execution context which hosts this/i.test(raw);
}

function disposeStub(stub: unknown): void {
  const dispose = (stub as { [Symbol.dispose]?: unknown } | null)?.[Symbol.dispose];
  if (typeof dispose !== "function") return;
  try {
    dispose.call(stub);
  } catch {}
}

function settleTeardownWithin(promise: Promise<unknown>): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, TEARDOWN_RPC_GRACE_MS);
    promise.then(finish, finish);
  });
}

export class PageScriptRpcSession implements PageScriptStub {
  private entrypoint: RpcSessionEntrypoint;
  private sessionReady: Promise<RpcSessionCallable>;
  private session: RpcSessionCallable | null = null;
  private inflight = new Set<InflightCall>();
  private dead = false;
  private deadReason: string | null = null;
  private wallCapTimer: ReturnType<typeof setTimeout> | null = null;
  private closeReady: Promise<void> | null = null;
  private scriptName: string | null = null;
  private defaultTimeoutMs: number;
  private now: () => number;
  private getTraceParent?: () => string | null;
  private upstreamHandler: UpstreamEventHandler | null = null;

  constructor(entrypoint: RpcSessionEntrypoint, opts: PageScriptRpcSessionOptions = {}) {
    this.entrypoint = entrypoint;
    const settings = pageScriptSessionSettings(opts);
    this.defaultTimeoutMs = settings.defaultTimeoutMs;
    this.getTraceParent = settings.getTraceParent;
    this.now = settings.now;
    this.scriptName = settings.scriptName;
    this.armWallCap(settings.wallCapMs);
    const outbound = opts.outbound;
    const doOpen = () => this.openSession(outbound);
    const opened = opts.wrapOpen ? opts.wrapOpen(doOpen) : doOpen();
    this.sessionReady = opened.then(
      (session) => this.acceptOpenedSession(session),
      (error) => this.failSessionOpen(error),
    );
    this.sessionReady.catch(() => {});
  }

  private armWallCap(wallCapMs: number): void {
    if (wallCapMs > 0) {
      this.wallCapTimer = setTimeout(() => this.fireWallCap(wallCapMs), wallCapMs);
    }
  }

  private openSession(outbound: SessionOutbound | undefined): Promise<RpcSessionCallable> {
    return this.entrypoint.openSession({
      ...(outbound ? { outbound } : {}),
      upstream: (message) => this.handleUpstream(message),
    });
  }

  private handleUpstream(message: UpstreamMessage): void {
    const params = upstreamParams(message);
    if (params === null) return;
    if (message.event === "kitesurf.wasmTerminated") {
      this.fireWasmTerminated(params);
      return;
    }
    const handler = this.upstreamHandler;
    if (!handler) return;
    try {
      handler(message.event, params);
    } catch (error) {
      console.warn(
        `[kitesurf-iframe] upstream handler threw for ${message.event}:`,
        upstreamErrorMessage(error),
      );
    }
  }

  private acceptOpenedSession(session: RpcSessionCallable): RpcSessionCallable {
    if (this.dead) {
      if (!this.closeReady) disposeStub(session);
      return session;
    }
    this.session = session;
    return session;
  }

  private failSessionOpen(error: unknown): never {
    this.markDead(`session open failed: ${rpcErrorMessage(error)}`);
    throw error;
  }

  private noteTransportDeath(raw: string): void {
    if (shouldIgnoreTransportDeath(this.dead, raw)) return;
    const announce = !this.retiring;
    if (announce) {
      console.warn(`[kitesurf] page isolate unreachable, ending session: ${raw}`);
    }
    this.markDead(`page isolate no longer reachable: ${raw}`);
    if (announce && this.scriptName) {
      notifyIsolateLimit(this.scriptName, {
        kind: "gone",
        capMs: 0,
        fromTail: false,
      });
    }
  }

  private fireWallCap(capMs: number): void {
    if (this.dead) return;
    this.wallCapTimer = null;
    const reason = `wall-clock cap exceeded (${capMs}ms)`;
    this.killIsolate(reason);
    this.markDead(reason);
    if (this.scriptName) {
      notifyIsolateLimit(this.scriptName, { kind: "wall", capMs, fromTail: false });
    }
  }

  // A trap poisons the wasm module: later calls fail, and an async call that trapped never replies.
  // End the generation so in-flight calls reject, and report it like a crashed renderer.
  private fireWasmTerminated(params: ReceivedUpstreamParams): void {
    if (this.dead) return;
    const MAX_TRAP_DETAIL_CHARS = 200;
    const raw = params.message;
    const detail =
      typeof raw === "string" && raw ? raw.slice(0, MAX_TRAP_DETAIL_CHARS) : "unknown trap";
    const reason = `page engine crashed (${detail})`;
    this.killIsolate(reason);
    this.markDead(reason);
    if (this.scriptName) {
      notifyIsolateLimit(this.scriptName, { kind: "crashed", capMs: 0, fromTail: false, detail });
    }
  }

  private markDead(reason: string): void {
    if (this.dead) return;
    this.dead = true;
    this.deadReason = reason;
    this.clearWallCapTimer();
    this.rejectInflightCalls(reason);
    this.disposeRenderPort();
    this.disposeSession();
  }

  private clearWallCapTimer(): void {
    if (this.wallCapTimer) {
      clearTimeout(this.wallCapTimer);
      this.wallCapTimer = null;
    }
  }

  private rejectInflightCalls(reason: string): void {
    for (const call of this.inflight) {
      if (call.settled) continue;
      call.settled = true;
      if (call.timer) clearTimeout(call.timer);
      call.reject(new Error(`PageScript.${call.method}: session ended (${reason})`));
    }
    this.inflight.clear();
  }

  private disposeRenderPort(): void {
    const port = this.renderPortStub;
    this.renderPortStub = null;
    disposeStub(port);
  }

  private disposeSession(): void {
    const session = this.session;
    this.session = null;
    if (!this.closeReady) disposeStub(session);
  }

  private async call<M extends PageScriptMethod>(
    method: M,
    params: PageScriptWireParams[M],
    timeoutMs?: number,
  ): Promise<PageScriptReply<M>> {
    this.assertSessionAlive(method);
    let session = this.session;
    if (!session) session = await this.awaitSessionOpen(method);
    const budget = timeoutMs ?? this.defaultTimeoutMs;
    const meta = this.callMetadata();
    return this.sendCall(session, method, params, budget, meta);
  }

  private async awaitSessionOpen(method: PageScriptMethod): Promise<RpcSessionCallable> {
    let session: RpcSessionCallable;
    try {
      session = await this.sessionReady;
    } catch (error) {
      throw new Error(`PageScript.${method}: session open failed (${rpcErrorMessage(error)})`);
    }
    if (this.dead) {
      throw new Error(
        `PageScript.${method}: session died during open (${this.deadReason ?? "unknown"})`,
      );
    }
    return session;
  }

  private assertSessionAlive(method: PageScriptMethod): void {
    if (this.dead) {
      throw new Error(`PageScript.${method}: session is dead (${this.deadReason ?? "unknown"})`);
    }
  }

  private callMetadata(): WireMeta {
    const traceParent = this.getTraceParent?.() ?? null;
    const meta: WireMeta = { t: this.now() };
    if (traceParent) meta.tp = traceParent;
    return meta;
  }

  private sendCall<M extends PageScriptMethod>(
    session: RpcSessionCallable,
    method: M,
    params: PageScriptWireParams[M],
    budget: number,
    meta: WireMeta,
  ): Promise<PageScriptReply<M>> {
    return new Promise<PageScriptReply<M>>((resolve, reject) => {
      const entry: InflightCall = { reject, timer: null, method, settled: false };
      if (budget > 0) {
        // This timer rejects the waiter; it does not cancel the underlying session call.
        entry.timer = setTimeout(() => this.expireCall(entry, budget, reject), budget);
      }
      this.inflight.add(entry);
      session.call(method, params, meta).then(
        (result) => this.resolveCall(entry, result, resolve),
        (error) => this.rejectCall(entry, method, error, reject),
      );
    });
  }

  private expireCall(
    entry: InflightCall,
    budget: number,
    reject: (reason?: unknown) => void,
  ): void {
    if (entry.settled) return;
    entry.settled = true;
    this.inflight.delete(entry);
    reject(new Error(`PageScript.${entry.method}: timeout after ${budget}ms`));
  }

  private resolveCall<M extends PageScriptMethod>(
    entry: InflightCall,
    result: PageScriptReply<M>,
    resolve: (value: PageScriptReply<M>) => void,
  ): void {
    if (entry.settled) return;
    entry.settled = true;
    this.inflight.delete(entry);
    if (entry.timer) clearTimeout(entry.timer);
    resolve(result);
  }

  private rejectCall(
    entry: InflightCall,
    method: PageScriptMethod,
    error: unknown,
    reject: (reason?: unknown) => void,
  ): void {
    if (entry.settled) return;
    entry.settled = true;
    this.inflight.delete(entry);
    if (entry.timer) clearTimeout(entry.timer);
    const raw = rpcErrorMessage(error);
    this.noteTransportDeath(raw);
    reject(new Error(`PageScript.${method}: ${raw}`));
  }

  private renderPort: Promise<RenderPortStub> | null = null;

  private renderPortStub: RenderPortStub | null = null;
  private retiring = false;

  getRenderPort(): Promise<RenderPortStub> {
    if (this.dead) {
      return Promise.reject(
        new Error(`PageScript session is dead (${this.deadReason ?? "unknown"})`),
      );
    }
    if (!this.renderPort) {
      const minted = this.sessionReady
        .then((session) => {
          if (this.dead) {
            throw new Error(`PageScript session is dead (${this.deadReason ?? "unknown"})`);
          }
          if (typeof session.makeRenderPort !== "function") {
            throw new Error("PageScript session lacks makeRenderPort");
          }
          return session.makeRenderPort();
        })
        .then((port) => {
          if (this.dead) {
            disposeStub(port);
            throw new Error(`PageScript session is dead (${this.deadReason ?? "unknown"})`);
          }
          this.renderPortStub = port;
          return port;
        });
      minted.catch(() => {
        if (this.renderPort === minted) this.renderPort = null;
      });
      this.renderPort = minted;
    }
    return this.renderPort;
  }

  killIsolate(reason = "generation retired"): Promise<void> {
    const ep = this.entrypoint;
    if (typeof ep.killIsolate !== "function") return Promise.resolve();
    const sessionClosed = this.closeReady ?? Promise.resolve();
    // Give the retained close one grace window before the entrypoint kill.
    return settleTeardownWithin(sessionClosed).then(() => {
      try {
        return settleTeardownWithin(Promise.resolve(ep.killIsolate?.(reason)));
      } catch {}
    });
  }

  close(reason = "session close"): void {
    if (this.dead) return;
    this.retiring = true;
    const closeSession = (session: RpcSessionCallable): Promise<void> => {
      const dispose = () => disposeStub(session);
      if (typeof session.close === "function") {
        try {
          return Promise.resolve(session.close()).then(dispose, dispose);
        } catch {
          dispose();
          return Promise.resolve();
        }
      }
      dispose();
      return Promise.resolve();
    };
    this.closeReady = this.session
      ? closeSession(this.session)
      : this.sessionReady.then(closeSession, () => {});
    this.markDead(reason);
  }

  setUpstreamEventHandler(handler: UpstreamEventHandler | null): void {
    this.upstreamHandler = handler;
  }

  navigate(
    html: Parameters<PageScriptStub["navigate"]>[0],
    url: Parameters<PageScriptStub["navigate"]>[1],
    opts?: Parameters<PageScriptStub["navigate"]>[2],
  ): ReturnType<PageScriptStub["navigate"]> {
    return this.call("navigate", { html, url, opts }, 30_000);
  }

  private awaitLoadInflight: Promise<LoadCompletion> | null = null;

  armAwaitLoad(): void {
    if (this.awaitLoadInflight || this.dead) return;
    this.awaitLoadInflight = this.call("awaitLoad", {}, 60_000);
    this.awaitLoadInflight.catch(() => {});
  }

  awaitLoad(): Promise<LoadCompletion> {
    if (!this.awaitLoadInflight) {
      this.awaitLoadInflight = this.call("awaitLoad", {}, 30_000);
    }
    return this.awaitLoadInflight;
  }

  async unload(): ReturnType<PageScriptStub["unload"]> {
    this.retiring = true;
    try {
      return await this.call("unload", {});
    } finally {
      setTimeout(() => this.close("after unload"), 0);
    }
  }

  drainConsole(): ReturnType<PageScriptStub["drainConsole"]> {
    return this.call("drainConsole", {});
  }

  syncCookies(cookies: string): Promise<{ ok: true }> {
    return this.call("syncCookies", { cookies });
  }

  installBindings(names: string[]): Promise<{ ok: true }> {
    return this.call("installBindings", { names }, 5_000);
  }

  installIframeContent(
    params: Parameters<PageScriptStub["installIframeContent"]>[0],
  ): ReturnType<PageScriptStub["installIframeContent"]> {
    return this.call("installIframeContent", params, 10_000);
  }

  iframeInstallsSettled(): Promise<{ ok: true }> {
    return this.call("iframeInstallsSettled", {}, 2_000);
  }

  setFrameBitmap(
    params: Parameters<PageScriptStub["setFrameBitmap"]>[0],
  ): ReturnType<PageScriptStub["setFrameBitmap"]> {
    return this.call("setFrameBitmap", params, 10_000);
  }

  deliverMessage(
    params: Parameters<PageScriptStub["deliverMessage"]>[0],
  ): ReturnType<PageScriptStub["deliverMessage"]> {
    return this.call("deliverMessage", params, 10_000);
  }

  deliverWorkerEvent(
    params: Parameters<PageScriptStub["deliverWorkerEvent"]>[0],
  ): ReturnType<PageScriptStub["deliverWorkerEvent"]> {
    return this.call("deliverWorkerEvent", params, 10_000);
  }

  evaluate(
    expression: string,
    opts: Parameters<PageScriptStub["evaluate"]>[1],
  ): ReturnType<PageScriptStub["evaluate"]> {
    return this.call("evaluate", { expression, opts });
  }

  callFunctionOn(
    functionDeclaration: string,
    argSpecs: Parameters<PageScriptStub["callFunctionOn"]>[1],
    opts: Parameters<PageScriptStub["callFunctionOn"]>[2],
  ): ReturnType<PageScriptStub["callFunctionOn"]> {
    return this.call("callFunctionOn", { functionDeclaration, argSpecs, opts });
  }

  releaseObject(objectId: string): Promise<{ ok: true }> {
    return this.call("releaseObject", { objectId });
  }

  getProperties(
    objectId: string,
    opts: Parameters<PageScriptStub["getProperties"]>[1],
  ): ReturnType<PageScriptStub["getProperties"]> {
    return this.call("getProperties", { objectId, opts });
  }

  compileScript(
    expression: string,
    sourceURL: string,
    persistScript: boolean,
  ): ReturnType<PageScriptStub["compileScript"]> {
    return this.call("compileScript", { expression, sourceURL, persistScript });
  }

  runScript(
    scriptId: string,
    opts: Parameters<PageScriptStub["runScript"]>[1],
  ): ReturnType<PageScriptStub["runScript"]> {
    return this.call("runScript", { scriptId, opts });
  }

  queryDom<M extends QueryDomMethod>(method: M, args: QueryDomArgs<M>): Promise<QueryDomResult<M>>;
  queryDom(
    method: QueryDomMethod,
    args: QueryDomArgs<QueryDomMethod>,
  ): Promise<QueryDomResult<QueryDomMethod>> {
    return this.call("queryDom", { method, args });
  }

  dispatchMouseEvent(
    type: string,
    init: MouseEventInit,
  ): ReturnType<PageScriptStub["dispatchMouseEvent"]> {
    return this.call("dispatchMouseEvent", { type, init });
  }

  dispatchKeyEvent(
    type: string,
    init: KeyEventInit,
  ): ReturnType<PageScriptStub["dispatchKeyEvent"]> {
    return this.call("dispatchKeyEvent", { type, init });
  }
}

export function openPageScriptRpcSession(
  entrypoint: RpcSessionEntrypoint,
  opts: PageScriptRpcSessionOptions = {},
): PageScriptRpcSession {
  return new PageScriptRpcSession(entrypoint, opts);
}
