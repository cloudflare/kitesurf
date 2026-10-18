// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Optional hooks an embedding host can bind. They aren't in the generated Env
// because the default template doesn't configure them.
export {};

declare global {
  interface Env {
    // Span recorder for deployed tracing; local runs use the OTLP exporter in
    // tracing-local.ts.
    HOST_TRACER?: import("./tracing.ts").Tracer;
    // Epoch clock for engine-side timing; Date.now is used when unset.
    HOST_CLOCK?: import("./eval/host-clock.ts").HostClock;
  }
}
