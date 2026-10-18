// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test, vi } from "vitest";
import { runSceneLoop, SCENE_HEARTBEAT_MS, type SceneFlow } from "../src/rbi.ts";

test.each([false, true])("scene heartbeats survive a slow record (reject=%s)", async (reject) => {
  vi.useFakeTimers();
  const frames: Uint8Array[] = [];
  const server: Pick<WebSocket, "send"> = {
    send(data) {
      if (!(data instanceof Uint8Array)) throw new Error("expected a binary scene envelope");
      frames.push(data);
    },
  };
  const flow: SceneFlow = {
    sent: 0,
    acked: 0,
    outstanding: new Map(),
    needFull: false,
  };
  let closed = false;
  const recordScene = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 6 * SCENE_HEARTBEAT_MS));
    closed = true;
    if (reject) throw new Error("record transport failed");
    return { unchanged: true };
  });
  try {
    const loop = runSceneLoop(
      recordScene,
      server,
      () => closed,
      flow,
      { w: 800, h: 600, fps: 60, text: false },
      () => 0,
    );
    await vi.advanceTimersByTimeAsync(5 * SCENE_HEARTBEAT_MS);
    expect(recordScene).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(5);
    for (const frame of frames) {
      expect(frame[0]).toBe(2);
      expect(JSON.parse(new TextDecoder().decode(frame.subarray(11)))).toEqual({ t: "sceneAlive" });
    }
    expect(flow.sent).toBe(0);
    await vi.advanceTimersByTimeAsync(SCENE_HEARTBEAT_MS);
    await loop;
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
