// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Defines host hooks and per-connection settings for engine embeddings.

import {
  resolveEntrypoint,
  type SessionEntrypoint,
  type TelemetryFactory,
} from "./observability.ts";
import type { EngineCdpCommandExtension } from "./cdp/dispatch.ts";
import type { ExternalOutbound } from "./eval/external-outbound.ts";
import { resolveInspectorBaseUrl } from "./inspector.ts";
import { landingPage } from "./landing.ts";
import type { RequestBlocker } from "./request-blocker.ts";
import { MemorySessionStore, type SessionStore } from "./state/session-store.ts";

export interface ConnectionOptions {
  /**
   * Analytics label for the session entry point.
   * Defaults to "devtools" on /devtools/page/* and "puppeteer" otherwise.
   */
  entrypoint?: SessionEntrypoint;
  /** Defer font work until layout demand (BrowserState.fontDefer). */
  fontDefer?: boolean;
}

export interface EngineHost {
  /** Handles unmatched routes; return `null` to keep the engine's 404 response. */
  serveFallback?(url: URL, env: Env): Promise<Response | null>;
  /** Creates a session telemetry sink; factory and sink errors are reported, not rethrown. */
  telemetry?: TelemetryFactory;
  /**
   * Runs before routing; a response rejects the request. Unset admits every
   * request.
   */
  admit?(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | null>;
  /**
   * Called once per CDP connection before the session starts. The connection
   * ID is also the analytics session ID, so a host can tag its error scope.
   */
  connectionOptions?(request: Request, connectionId: string): ConnectionOptions | undefined;
  /**
   * Header names copied from the upgrade request for CPU attribution.
   * A non-empty value enables `AttributionTail` on the session's workers.
   */
  attributionHeaders?: readonly string[];
  /**
   * Creates one handler per connection for unhandled Kitesurf methods.
   * The handler returns `{ handled: false }` for method-not-found; its errors become CDP errors.
   */
  createCdpCommandExtension?(env: Env): EngineCdpCommandExtension;
  /**
   * Blocks matching subresources and child frames before egress or OOPIF spawn.
   * Top-level navigations are exempt. Unset blocks nothing beyond outbound filters.
   */
  requestBlocker?: RequestBlocker;
  /**
   * Per-connection transport that replaces `fetch` after engine policy; must fit in worker props.
   * An external outbound takes precedence. Unset uses `fetch`.
   */
  egress?(env: Env, ctx: ExecutionContext): ExternalOutbound | undefined;
  /**
   * Creates the store a session keeps its data in. Unset, or returning nothing, keeps every
   * table on the isolate heap (`MemorySessionStore`), which is what a plain session wants.
   */
  createSessionStore?(connectionId: string, env: Env): SessionStore | undefined;
  /**
   * Extra modules for each page isolate, and the name of a Durable Object class one exports.
   * The engine generates the entry module, since the class lookup reads only its exports.
   */
  pageIsolate?: {
    modules?: Record<string, string>;
    hostClassName?: string;
  };
}

/** The store for this connection: the host's, or one on the heap. */
export function resolveSessionStore(
  connectionId: string,
  env: Env,
  host?: EngineHost,
): SessionStore {
  return host?.createSessionStore?.(connectionId, env) ?? new MemorySessionStore();
}

/** Applies host overrides and defaults before opening a CDP connection. */
export function resolveConnectionOptions(
  request: Request,
  connectionId: string,
  host?: EngineHost,
): Required<ConnectionOptions> {
  const overrides = host?.connectionOptions?.(request, connectionId);
  return {
    entrypoint: overrides?.entrypoint ?? resolveEntrypoint(request),
    fontDefer: overrides?.fontDefer ?? false,
  };
}

// The standalone engine answers `/` with its landing page; embedders own their root.
export const DEFAULT_ENGINE_HOST: EngineHost = Object.freeze({
  serveFallback: async (url: URL, env: Env) => {
    if (url.pathname !== "/") return null;
    return landingPage(url, await resolveInspectorBaseUrl(env));
  },
});
