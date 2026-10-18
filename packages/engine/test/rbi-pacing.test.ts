// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, it, vi } from "vitest";
import { runSceneLoop, type SceneFlow } from "../src/rbi.ts";

it.each([100, 150])(
  "retries a deferred rAF after %i ms work without another full frame wait",
  async (workMs) => {
    vi.useFakeTimers();
    const startedAt = 1_000;
    const postCallbackGapMs = 16;
    vi.setSystemTime(startedAt);
    let closed = false;
    const calls: number[] = [];
    const flow: SceneFlow = { sent: 0, acked: 0, outstanding: new Map(), needFull: false };
    try {
      const loop = runSceneLoop(
        async () => {
          calls.push(Date.now());
          if (calls.length === 1) {
            vi.setSystemTime(Date.now() + workMs);
            return { seq: 1, scene: new Uint8Array([1]) };
          }
          if (calls.length === 2) {
            return { seq: 1, unchanged: true, nextRafDelayMs: postCallbackGapMs };
          }
          closed = true;
          return { seq: 2, scene: new Uint8Array([2]) };
        },
        { send() {} },
        () => closed,
        flow,
        { w: 64, h: 64, fps: 30, text: false },
        () => 0,
      );
      await vi.runAllTimersAsync();
      await loop;
      expect(calls).toEqual([
        startedAt,
        startedAt + workMs,
        startedAt + workMs + postCallbackGapMs,
      ]);
    } finally {
      closed = true;
      vi.useRealTimers();
    }
  },
);

it("keeps the requested cadence when the frame was not deferred", async () => {
  vi.useFakeTimers();
  const startedAt = 1_000;
  vi.setSystemTime(startedAt);
  let closed = false;
  const calls: number[] = [];
  const flow: SceneFlow = { sent: 0, acked: 0, outstanding: new Map(), needFull: false };
  try {
    const loop = runSceneLoop(
      async () => {
        calls.push(Date.now());
        closed = calls.length === 2;
        return { seq: calls.length, scene: new Uint8Array([calls.length]) };
      },
      { send() {} },
      () => closed,
      flow,
      { w: 64, h: 64, fps: 30, text: false },
      () => 0,
    );
    await vi.runAllTimersAsync();
    await loop;
    expect(calls).toEqual([startedAt, startedAt + Math.floor(1_000 / 30)]);
  } finally {
    closed = true;
    vi.useRealTimers();
  }
});
