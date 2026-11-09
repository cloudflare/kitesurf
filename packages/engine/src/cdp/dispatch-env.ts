// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Builds the wasm-free environment passed to CDP dispatch handlers.

// Keep this adapter wasm-free; its only value import is the runtime guard.
import type { DispatchCtx } from "./dispatch.ts";
import type { HostClock } from "../eval/host-clock.ts";

export function buildDispatchEnv(env: Env): DispatchCtx["env"] {
  return {
    LOADER: env.LOADER,
    FONT_ASSETS: env.FONT_ASSETS,
    KITESURF_SIMULATE_PROD_EVAL: env.KITESURF_SIMULATE_PROD_EVAL,
    KITESURF_RESOURCE_DRAIN_QUIET_TURNS: env.KITESURF_RESOURCE_DRAIN_QUIET_TURNS,
    KITESURF_PAGE_CPU_MS_CAP: env.KITESURF_PAGE_CPU_MS_CAP,
    KITESURF_PAGE_WALL_MS_CAP: env.KITESURF_PAGE_WALL_MS_CAP,
    KITESURF_LAG_WATCHDOG: env.KITESURF_LAG_WATCHDOG,
    KITESURF_ALLOW_PRIVATE_NETWORK: env.KITESURF_ALLOW_PRIVATE_NETWORK,
    HOST_TRACER: env.HOST_TRACER,
    HOST_CLOCK: (
      env as {
        HOST_CLOCK?: HostClock;
      }
    ).HOST_CLOCK,
  };
}
