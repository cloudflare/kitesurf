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
import { landingPage } from "./landing.ts";
import type { RequestBlocker } from "./request-blocker.ts";

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
}

/** Applies host overrides and defaults before opening a CDP connection. */
export function resolveConnectionOptions(
  request: Request,
  connectionId: string,
  host?: EngineHost,
): Required<ConnectionOptions> {
  const overrides = host?.connectionOptions?.(request, connectionId);
  return resolveOptions(request, overrides);
}

function resolveOptions(
  request: Request,
  overrides: ConnectionOptions | undefined,
): Required<ConnectionOptions> {
  const entrypoint = overrides?.entrypoint;
  const fontDefer = overrides?.fontDefer;
  return {
    entrypoint: entrypoint === undefined ? resolveEntrypoint(request) : entrypoint,
    fontDefer: fontDefer === undefined ? false : fontDefer,
  };
}

// The standalone engine answers `/` with chrome://inspect instructions; embedders own their root.
export const DEFAULT_ENGINE_HOST: EngineHost = Object.freeze({
  serveFallback: async (url: URL) => (url.pathname === "/" ? landingPage(url) : null),
});
