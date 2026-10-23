// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Resolves CDP targets to PageScript generations and routes typed DOM queries.

import type { DispatchCtx } from "./dispatch.ts";
import type { TargetState } from "./types.ts";
import type { PageScriptStub } from "../eval/page-script.ts";
import type { PageScriptSession } from "@kitesurf/jsrpc-types/page-script";
export type {
  EnumeratedStyleSheet,
  QueryDomArgs,
  QueryDomMethod,
  QueryDomMethods,
  QueryDomResult,
} from "@kitesurf/jsrpc-types/query-dom";
import type { QueryDomArgs, QueryDomMethod, QueryDomResult } from "@kitesurf/jsrpc-types/query-dom";

export type QueryDomCarrier = Pick<PageScriptSession, "queryDom">;

export function stubQueryDom<M extends QueryDomMethod>(
  stub: QueryDomCarrier,
  method: M,
  args: QueryDomArgs<M>,
): Promise<QueryDomResult<M>> {
  return stub.queryDom(method, args);
}

type EnsurePageScriptFn = (
  dctx: DispatchCtx,
  target: TargetState | undefined,
) => PageScriptStub | null;

const READY_RETRY = Symbol("ready-retry");

let ensureImpl: EnsurePageScriptFn | null = null;

export function registerEnsurePageScript(fn: EnsurePageScriptFn): void {
  ensureImpl = fn;
}

export function resolveTarget(
  ctx: DispatchCtx,
  sessionId: string | undefined,
  noTargetMessage = "No page target attached to session",
): TargetState {
  const matched = targetForSession(ctx, sessionId);
  if (matched) return matched;
  const page = firstPageTarget(ctx);
  if (page) return page;
  throw new Error(noTargetMessage);
}

function targetForSession(
  ctx: DispatchCtx,
  sessionId: string | undefined,
): TargetState | undefined {
  if (!sessionId) return undefined;
  for (const t of ctx.browser.targets.values()) {
    if (t.sessions.has(sessionId)) return t;
  }
  return undefined;
}

function firstPageTarget(ctx: DispatchCtx): TargetState | undefined {
  for (const t of ctx.browser.targets.values()) {
    if (t.type === "page") return t;
  }
  return undefined;
}

export type SessionOps = {
  readonly [M in QueryDomMethod]: (args: QueryDomArgs<M>) => Promise<QueryDomResult<M>>;
};

export type SessionSoftOps = {
  readonly [M in QueryDomMethod]: (args: QueryDomArgs<M>) => Promise<QueryDomResult<M> | null>;
};

export class PageSession {
  readonly #dctx: DispatchCtx;
  readonly #target: TargetState;
  #pinned?: { generation: number; stub: PageScriptStub };

  readonly call: SessionOps;

  readonly tryCall: SessionSoftOps;

  readonly callIfLive: SessionSoftOps;

  constructor(dctx: DispatchCtx, target: TargetState) {
    this.#dctx = dctx;
    this.#target = target;
    this.call = this.#ops("call") as SessionOps;
    this.tryCall = this.#ops("try") as SessionSoftOps;
    this.callIfLive = this.#ops("ifLive") as SessionSoftOps;
  }

  #ops(kind: "call" | "try" | "ifLive"): unknown {
    const cache = new Map<string, (args: Record<string, unknown>) => unknown>();
    return new Proxy(Object.create(null), {
      get: (_t, prop) => {
        if (typeof prop !== "string" || prop === "then") return undefined;
        let fn = cache.get(prop);
        if (!fn) {
          fn = (args) => this.#dispatch(kind, prop as QueryDomMethod, args as never);
          cache.set(prop, fn);
        }
        return fn;
      },
    });
  }

  async #dispatch<M extends QueryDomMethod>(
    kind: "call" | "try" | "ifLive",
    method: M,
    args: QueryDomArgs<M>,
  ): Promise<QueryDomResult<M> | null> {
    if (this.#pinned) return this.#dispatchPinned(kind, method, args);
    if (kind === "ifLive") return this.#dispatchIfLive(method, args);
    return this.#dispatchReady(kind, method, args);
  }

  async #dispatchPinned<M extends QueryDomMethod>(
    kind: "call" | "try" | "ifLive",
    method: M,
    args: QueryDomArgs<M>,
  ): Promise<QueryDomResult<M> | null> {
    const stub = this.live();
    if (!stub) {
      if (kind === "call") throw new Error("PageScript generation retired");
      return null;
    }
    try {
      return await stubQueryDom(stub, method, args);
    } catch (err) {
      if (kind === "call") throw err;
      return null;
    }
  }

  async #dispatchIfLive<M extends QueryDomMethod>(
    method: M,
    args: QueryDomArgs<M>,
  ): Promise<QueryDomResult<M> | null> {
    const stub = this.#target.pageScript;
    if (!stub) return null;
    try {
      await this.#settleBlank();
      return await stubQueryDom(stub, method, args);
    } catch {
      return null;
    }
  }

  async #dispatchReady<M extends QueryDomMethod>(
    kind: "call" | "try",
    method: M,
    args: QueryDomArgs<M>,
  ): Promise<QueryDomResult<M> | null> {
    const stub = await this.ready();
    if (!stub) {
      if (kind === "call") throw new Error("No PageScript isolate for target");
      return null;
    }
    if (kind === "call") return stubQueryDom(stub, method, args);
    try {
      return await stubQueryDom(stub, method, args);
    } catch {
      return null;
    }
  }

  /**
   * Waits for pending `about:blank` setup and checks that the PageScript is still current.
   * Returns `null` when no isolate is available.
   */
  async ready(): Promise<PageScriptStub | null> {
    if (this.#pinned) return this.live();
    while (true) {
      const attempt = await this.#readyAttempt();
      if (attempt !== READY_RETRY) return attempt;
    }
  }

  async #readyAttempt(): Promise<PageScriptStub | null | typeof READY_RETRY> {
    const gate = this.#target.blankReady;
    if (gate) await gate;
    const stub = this.ensure();
    if (stub) return this.#recheckStub(stub);
    return shouldStopWaitingForStub(stub, this.#target.blankReady, gate) ? null : READY_RETRY;
  }

  async #recheckStub(stub: PageScriptStub): Promise<PageScriptStub | typeof READY_RETRY> {
    await this.#settleBlank();
    // Recheck after the await because navigation may have replaced this stub.
    return isCurrentStub(this.#target, stub) ? stub : READY_RETRY;
  }

  // A pinned view must not hop to a newer document after an awaited read.
  /**
   * Pins calls to the current generation so an awaited read cannot switch documents.
   * Returns `null` when no PageScript is live.
   */
  pin(): PageSession | null {
    const stub = this.live();
    if (!stub) return null;
    const pinned = new PageSession(this.#dctx, this.#target);
    pinned.#pinned = { generation: this.#target.navigateGeneration, stub };
    return pinned;
  }

  live(): PageScriptStub | null {
    if (this.#pinned && !isCurrentPinnedStub(this.#target, this.#pinned)) return null;
    return this.#pinned?.stub ?? this.#target.pageScript;
  }

  isLive(): boolean {
    return this.live() !== null;
  }

  ensure(): PageScriptStub | null {
    if (this.#pinned) return this.live();
    if (this.#target.pageScript) return this.#target.pageScript;
    return ensureImpl ? ensureImpl(this.#dctx, this.#target) : null;
  }

  available(): boolean {
    return this.ensure() !== null;
  }

  async #settleBlank(): Promise<void> {
    const blank = this.#target.blankReady;
    if (blank) await blank;
  }
}

function isCurrentStub(target: TargetState, stub: PageScriptStub): boolean {
  return target.pageScript === stub;
}

function readySetupSettled(
  blankReady: Promise<void> | null | undefined,
  gate: Promise<void> | null | undefined,
): boolean {
  return !blankReady || blankReady === gate;
}

function shouldStopWaitingForStub(
  stub: PageScriptStub | null,
  blankReady: Promise<void> | null | undefined,
  gate: Promise<void> | null | undefined,
): boolean {
  return !stub && readySetupSettled(blankReady, gate);
}

function isCurrentPinnedStub(
  target: TargetState,
  pinned: { generation: number; stub: PageScriptStub },
): boolean {
  return target.navigateGeneration === pinned.generation && target.pageScript === pinned.stub;
}

export function sessionOf(dctx: DispatchCtx, target: TargetState): PageSession {
  return (target.pageSession ??= new PageSession(dctx, target));
}

export function resolveSession(ctx: DispatchCtx, sessionId: string | undefined): PageSession {
  return sessionOf(ctx, resolveTarget(ctx, sessionId));
}
