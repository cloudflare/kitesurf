// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Stable surface for Workers that wrap the engine; anything not exported here is internal.

export {
  KitesurfEngine,
  SandboxOutbound,
  PageScriptTail,
  DeniedOutbound,
  SpanSink,
} from "./index.ts";
export { DEFAULT_ENGINE_HOST } from "./host.ts";
export type { EngineHost, ConnectionOptions } from "./host.ts";
export type { BlockableRequest, RequestBlocker, RequestBlockVerdict } from "./request-blocker.ts";
export type { ResourceType } from "./cdp/network-events.ts";
export { SESSION_ID_HEADER, resolveEntrypoint } from "./observability.ts";
export type {
  SessionEntrypoint,
  SessionTelemetry,
  TelemetryEvent,
  TelemetryFactory,
  TelemetryInit,
} from "./observability.ts";
export { traceSpan } from "./tracing.ts";
export type { Tracer } from "./tracing.ts";
export { armLocalTracing, localTraceparentHeader } from "./tracing-local.ts";
export { handleWebSocket } from "./cdp/connection.ts";
export { parseCdpRequest, SKIP_SPECULATIVE_RASTER_HEADER } from "./cdp/types.ts";
export type { CdpRequest, CdpResponse } from "./cdp/types.ts";
export { arrivalOf } from "./cdp/arrival.ts";
export { ensurePageScript } from "./cdp/dom.ts";
export { handleInput } from "./cdp/input.ts";
export { buildTree } from "./cdp/accessibility.ts";
export type { AxNode, BuiltTree, DomNode } from "./cdp/accessibility.ts";
export { handlePage, mainFrame } from "./cdp/page.ts";
export { sessionOf } from "./cdp/page-session.ts";
export type { PageSession } from "./cdp/page-session.ts";
export type { DispatchCtx, EngineCdpCommandExtension } from "./cdp/dispatch.ts";
export type { TargetState } from "./cdp/types.ts";
export { makeWallClock } from "./eval/host-clock.ts";
export { isRecord, isStringArray, oneOf } from "./guards.ts";
export { clampSide, clampViewport, MAX_PIXELS, MAX_SIDE, MIN_DIM } from "./cdp/viewport.ts";
export { compileOutboundFilters, shouldBlock } from "./cdp/outbound-filter-registry.ts";
export { rateLimited, warnLimiterFailure, isRateLimitedEntrypoint } from "./rate-limit.ts";
export type { AttributionTailProps } from "./eval/attribution-tail.ts";
export type { ExternalOutbound } from "./eval/external-outbound.ts";
export { classifyOrigin, parseKsErrLine } from "./engine-errors.ts";
export type { ErrorOrigin, TailExceptionReport } from "./engine-errors.ts";
