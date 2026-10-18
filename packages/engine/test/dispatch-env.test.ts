// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { buildDispatchEnv } from "../src/cdp/dispatch-env";
import type { DispatchCtx } from "../src/cdp/dispatch";

const STRING_ENV_KEYS = [
  "KITESURF_SIMULATE_PROD_EVAL",
  "KITESURF_RESOURCE_DRAIN_QUIET_TURNS",
  "KITESURF_PAGE_CPU_MS_CAP",
  "KITESURF_PAGE_WALL_MS_CAP",
  "KITESURF_DISABLE_PRECISE_TIMERS",
  "KITESURF_LAG_WATCHDOG",
] as const;

type DispatchEnv = DispatchCtx["env"];
type StringEnvKey = {
  [K in keyof DispatchEnv]-?: NonNullable<DispatchEnv[K]> extends string ? K : never;
}[keyof DispatchEnv];
type Unlisted = Exclude<StringEnvKey, (typeof STRING_ENV_KEYS)[number]>;
const _everyStringKeyListed: Unlisted extends never ? true : never = true;
void _everyStringKeyListed;

describe("buildDispatchEnv", () => {
  it("forwards every declared string env var (regression: silently-dead caps)", () => {
    const sentinelEnv: Record<string, unknown> = {
      LOADER: { load: () => {} },
      FONT_ASSETS: { fetch: () => {} },
      HOST_TRACER: undefined,
      HOST_CLOCK: undefined,
    };
    for (const key of STRING_ENV_KEYS) {
      sentinelEnv[key] = `sentinel:${key}`;
    }
    const picked = buildDispatchEnv(
      // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only copied Env keys are present.
      sentinelEnv as unknown as Parameters<typeof buildDispatchEnv>[0],
    );
    for (const key of STRING_ENV_KEYS) {
      expect(picked[key], `${key} must be forwarded to DispatchCtx.env`).toBe(`sentinel:${key}`);
    }
    expect(picked.LOADER).toBe(sentinelEnv.LOADER);
    expect(picked.FONT_ASSETS).toBe(sentinelEnv.FONT_ASSETS);
  });
});
