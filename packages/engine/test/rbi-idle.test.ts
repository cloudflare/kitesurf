// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test, vi } from "vitest";
import { claimSceneAck, runSceneLoop, wakeSceneFlow, type SceneFlow } from "../src/rbi.ts";

type RecordScene = Parameters<typeof runSceneLoop>[0];
type Reply = Awaited<ReturnType<RecordScene>>;

async function withLoop(
  record: RecordScene,
  check: (loop: { flow: SceneFlow; frames: Uint8Array[]; navigate: () => void }) => Promise<void>,
  canIdle?: () => boolean,
) {
  vi.useFakeTimers();
  const flow: SceneFlow = { sent: 0, acked: 0, outstanding: new Map(), needFull: false };
  const frames: Uint8Array[] = [];
  let closed = false;
  let generation = 0;
  const done = runSceneLoop(
    record,
    {
      send(bytes) {
        if (!(bytes instanceof Uint8Array)) throw new Error("expected scene bytes");
        frames.push(bytes);
      },
    },
    () => closed,
    flow,
    { w: 800, h: 600, fps: 60, text: false, canIdle },
    () => generation,
  );
  try {
    await vi.advanceTimersByTimeAsync(1);
    await check({
      flow,
      frames,
      navigate() {
        generation++;
        wakeSceneFlow(flow);
      },
    });
  } finally {
    closed = true;
    flow.wake?.();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
}

const scene = (seq = 1): Reply => ({ scene: new Uint8Array([seq]), seq, idle: true });
const scenes = (frames: Uint8Array[]) => frames.filter((frame) => frame[0] === 3 || frame[0] === 5);

test("idle scenes flush immediately, then record only at the backstop and keep heartbeats", async () => {
  const record = vi
    .fn<RecordScene>()
    .mockResolvedValueOnce(scene())
    .mockResolvedValue({ unchanged: true, seq: 1, idle: true });
  await withLoop(record, async ({ flow, frames }) => {
    expect(scenes(frames)).toHaveLength(1);
    expect(claimSceneAck(flow, 1)).toBe(true);
    await vi.advanceTimersByTimeAsync(900);
    expect(record).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2200);
    expect(record).toHaveBeenCalledTimes(4);
    expect(scenes(frames)).toHaveLength(1);
    const infos = frames
      .filter((frame) => frame[0] === 2)
      .map((frame) => JSON.parse(new TextDecoder().decode(frame.subarray(11))) as { t: string });
    expect(infos.filter((info) => info.t === "sceneAlive")).toHaveLength(3);
  });
});

test("paint wakes and rejected-frame recovery interrupt idle sleep without bypassing fps", async () => {
  const record = vi.fn<RecordScene>().mockResolvedValueOnce(scene(1)).mockResolvedValue(scene(2));
  await withLoop(record, async ({ flow, frames }) => {
    expect(claimSceneAck(flow, 1)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    wakeSceneFlow(flow);
    await vi.advanceTimersByTimeAsync(1);
    expect(record).toHaveBeenCalledTimes(2);
    expect(scenes(frames)).toHaveLength(2);
    expect(claimSceneAck(flow, 2)).toBe(true);
    flow.needFull = true;
    wakeSceneFlow(flow);
    await vi.advanceTimersByTimeAsync(1);
    expect(record).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20);
    expect(record).toHaveBeenCalledTimes(3);
    expect(record.mock.calls[2]?.[0]).toMatchObject({ sinceSeq: -1, baseSeq: -1 });
    expect(scenes(frames)).toHaveLength(3);
  });
});

test("a paint wake during the record reply cannot be lost when entering idle", async () => {
  let wakeDuringRecord: (() => void) | undefined;
  const record = vi.fn<RecordScene>(async () => {
    wakeDuringRecord?.();
    wakeDuringRecord = undefined;
    return scene(2);
  });
  await withLoop(record, async ({ flow }) => {
    expect(claimSceneAck(flow, 2)).toBe(true);
    wakeDuringRecord = () => wakeSceneFlow(flow);
    wakeSceneFlow(flow);
    await vi.advanceTimersByTimeAsync(40);
    expect(record).toHaveBeenCalledTimes(3);
  });
});

test("animation work keeps frame-rate pumping even when it does not change pixels", async () => {
  const record = vi.fn<RecordScene>().mockResolvedValue({ unchanged: true, seq: 1, idle: false });
  await withLoop(record, async () => {
    await vi.advanceTimersByTimeAsync(500);
    expect(record.mock.calls.length).toBeGreaterThan(25);
    expect(record.mock.calls.length).toBeLessThanOrEqual(33);
  });
});

test("navigation interrupts idle sleep, resets credits and establishes a fresh full base", async () => {
  const record = vi.fn<RecordScene>().mockResolvedValue(scene(1));
  await withLoop(record, async ({ frames, navigate }) => {
    await vi.advanceTimersByTimeAsync(100);
    navigate();
    await vi.advanceTimersByTimeAsync(1);
    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[1]?.[0]).toMatchObject({ sinceSeq: -1, baseSeq: -1 });
    expect(scenes(frames)).toHaveLength(2);
    const next = scenes(frames)[1];
    if (!next) throw new Error("missing scene after navigation");
    expect(new DataView(next.buffer).getUint32(3, true)).toBeGreaterThan(1);
  });
});

test("targets whose children cannot push paint wakes keep polling", async () => {
  const record = vi.fn<RecordScene>().mockResolvedValue({ unchanged: true, seq: 1, idle: true });
  await withLoop(
    record,
    async () => {
      await vi.advanceTimersByTimeAsync(100);
      expect(record.mock.calls.length).toBeGreaterThan(5);
      expect(record.mock.calls.every(([args]) => args.armWake === false)).toBe(true);
    },
    () => false,
  );
});
