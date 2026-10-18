// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { makeWallClock } from "../src/eval/host-clock";

describe("makeWallClock", () => {
  it("uses HOST_CLOCK when the binding is present", () => {
    let calls = 0;
    const env = {
      HOST_CLOCK: {
        timeOrigin: 1_000_000,
        now() {
          calls++;
          return 234.5;
        },
      },
    };
    const now = makeWallClock(env);
    expect(now()).toBe(1_000_234.5);
    expect(calls).toBe(1);
    env.HOST_CLOCK.now = () => 500;
    expect(now()).toBe(1_000_500);
  });

  it("falls back to Date.now without the binding", () => {
    for (const env of [undefined, null, {}, { HOST_CLOCK: null }]) {
      const before = Date.now();
      const value = makeWallClock(env)();
      const after = Date.now();
      expect(value).toBeGreaterThanOrEqual(before);
      expect(value).toBeLessThanOrEqual(after);
    }
  });

  it("falls back when the binding is malformed", () => {
    const noNow = makeWallClock({ HOST_CLOCK: { timeOrigin: 5 } });
    const noOrigin = makeWallClock({ HOST_CLOCK: { now: () => 5 } });
    const before = Date.now();
    expect(noNow()).toBeGreaterThanOrEqual(before);
    expect(noOrigin()).toBeGreaterThanOrEqual(before);
  });
});
