// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Groups typed CDP method handlers into the domains dispatch routes to.

import type { DispatchCtx } from "./dispatch.ts";
import {
  CDP_COMMAND_UNHANDLED,
  type CdpMethod,
  type CdpReplyBody,
  type CdpRequest,
  type CdpRequestOf,
  type RawJsonResult,
} from "./types.ts";

type DomainOf<M extends string> = M extends `${infer D}.${string}` ? D : never;

/** A domain name the protocol defines, such as "DOM" or "Kitesurf". */
export type CdpDomainName = DomainOf<CdpMethod>;

export type CdpMethodsIn<D extends string> = Extract<CdpMethod, `${D}.${string}`>;

export type CdpHandlerResult<M extends CdpMethod> =
  | CdpReplyBody<M>
  | RawJsonResult<CdpReplyBody<M>>;

export type CdpHandler<M extends CdpMethod, C> = (
  c: C,
  req: CdpRequestOf<M>,
) => CdpHandlerResult<M> | Promise<CdpHandlerResult<M>>;

/**
 * The handlers of domain `D`, keyed by method and checked against the protocol. An arrow's
 * returned literal gets no excess-property check, so only a method with no result is exact ({}).
 */
export type CdpDomainMethods<D extends string, C = DispatchCtx> = {
  [M in CdpMethodsIn<D>]?: CdpHandler<M, C>;
};

/** A method Kitesurf accepts and does nothing for. It fits only methods with no result. */
export function stub(): Record<string, never> {
  return {};
}

/** A defined domain. `A` is what the caller passes to `run` after the request, for `context`. */
export interface CdpDomain<A extends unknown[] = []> {
  readonly name: string;
  readonly methods: ReadonlySet<string>;
  /**
   * Answers `req`. For a method the domain does not define, answers with its fallback, or returns
   * CDP_COMMAND_UNHANDLED when it has none.
   */
  run(ctx: DispatchCtx, req: CdpRequest, ...args: A): Promise<unknown>;
}

/** Answers a command the map does not define, as a switch handler's default branch did. */
export type CdpFallback = (ctx: DispatchCtx, req: CdpRequest) => unknown;

/** Thrown to answer a command with Chrome's -32601 method-not-found error. */
export class CdpMethodNotFound extends Error {
  constructor(method: string) {
    super(`'${method}' wasn't found`);
    this.name = "CdpMethodNotFound";
  }
}

// Method syntax makes the parameters bivariant, so every typed handler and context fits. That is
// the one unchecked step: `run` looks the handler up by `req.method`, so `req` matches it.
interface ErasedHandler {
  call(c: unknown, req: CdpRequest): unknown;
}
interface ErasedContext {
  call(ctx: DispatchCtx, req: CdpRequest, ...args: unknown[]): unknown;
}

/**
 * Defines domain `name`. `context` runs before every command, defined or not, with what `run` got
 * after the request; the handlers receive its value, or the DispatchCtx without one.
 */
export function defineDomain<D extends CdpDomainName, C = DispatchCtx, A extends unknown[] = []>(
  name: D,
  spec: {
    context?: (ctx: DispatchCtx, req: CdpRequestOf<CdpMethodsIn<D>>, ...args: A) => C | Promise<C>;
    methods: CdpDomainMethods<D, C>;
    fallback?: CdpFallback;
  },
): CdpDomain<A> {
  return buildMethodTable(name, `${name}.`, spec.context, spec.methods, spec.fallback);
}

/** The handlers of a session that answers methods of several domains, keyed by method. */
export type CdpSessionMethods<C = DispatchCtx> = {
  [M in CdpMethod]?: CdpHandler<M, C>;
};

/**
 * Defines the commands one kind of session answers, such as a synthetic target's, from any
 * domain. `context` works as it does for defineDomain.
 */
export function defineSessionMethods<C = DispatchCtx, A extends unknown[] = []>(
  name: string,
  spec: {
    context?: (ctx: DispatchCtx, req: CdpRequest, ...args: A) => C | Promise<C>;
    methods: CdpSessionMethods<C>;
    fallback?: CdpFallback;
  },
): CdpDomain<A> {
  return buildMethodTable(name, null, spec.context, spec.methods, spec.fallback);
}

function buildMethodTable<A extends unknown[]>(
  name: string,
  prefix: string | null,
  contextOf: ErasedContext["call"] | undefined,
  table: { readonly [method: string]: ErasedHandler["call"] | undefined },
  fallback: CdpFallback | undefined,
): CdpDomain<A> {
  const handlers = new Map<string, ErasedHandler>();
  for (const [method, call] of Object.entries(table)) {
    if (!call) continue;
    // The key type confines methods to the domain; a cast or a spread could still add one.
    if (prefix !== null && !method.startsWith(prefix)) {
      throw new Error(`${method} is not a ${name} method`);
    }
    handlers.set(method, { call });
  }
  const context: ErasedContext = { call: contextOf ?? ((ctx: DispatchCtx) => ctx) };
  return {
    name,
    methods: new Set(handlers.keys()),
    async run(ctx, req, ...args) {
      // A switch handler ran synchronously up to its first await; a synchronous context keeps that.
      const built = context.call(ctx, req, ...args);
      const c = built instanceof Promise ? await built : built;
      const handler = handlers.get(req.method);
      if (!handler) return fallback ? fallback(ctx, req) : CDP_COMMAND_UNHANDLED;
      return handler.call(c, req);
    },
  };
}
