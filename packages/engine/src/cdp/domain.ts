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

export interface CdpDomain {
  readonly name: string;
  readonly methods: ReadonlySet<string>;
  /** Answers `req`, or returns CDP_COMMAND_UNHANDLED when the domain does not define its method. */
  run(ctx: DispatchCtx, req: CdpRequest): Promise<unknown>;
}

// Method syntax makes the parameters bivariant, so every typed handler and context fits. That is
// the one unchecked step: `run` looks the handler up by `req.method`, so `req` matches it.
interface ErasedHandler {
  call(c: unknown, req: CdpRequest): unknown;
}
interface ErasedContext {
  call(ctx: DispatchCtx, req: CdpRequest): unknown;
}

/**
 * Defines domain `name`. `context` runs before every command of the domain, including ones it
 * does not define, and the handlers receive its value; without it they get the DispatchCtx.
 */
export function defineDomain<D extends CdpDomainName, C = DispatchCtx>(
  name: D,
  spec: {
    context?: (ctx: DispatchCtx, req: CdpRequestOf<CdpMethodsIn<D>>) => C | Promise<C>;
    methods: CdpDomainMethods<D, C>;
  },
): CdpDomain {
  const methods: { readonly [method: string]: ErasedHandler["call"] | undefined } = spec.methods;
  const handlers = new Map<string, ErasedHandler>();
  for (const [method, call] of Object.entries(methods)) {
    if (!call) continue;
    // The key type confines methods to the domain; a cast or a spread could still add one.
    if (!method.startsWith(`${name}.`)) throw new Error(`${method} is not a ${name} method`);
    handlers.set(method, { call });
  }
  const context: ErasedContext = { call: spec.context ?? ((ctx: DispatchCtx) => ctx) };
  return {
    name,
    methods: new Set(handlers.keys()),
    async run(ctx, req) {
      // A switch handler ran synchronously up to its first await; a synchronous context keeps that.
      const built = context.call(ctx, req);
      const c = built instanceof Promise ? await built : built;
      const handler = handlers.get(req.method);
      if (!handler) return CDP_COMMAND_UNHANDLED;
      return handler.call(c, req);
    },
  };
}
