// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import {
  WheelQueue,
  cancelAndRemoveTargetWheelQueues,
  findWheelQueues,
  flushWheelQueues,
  getWheelQueue,
  moveWheelQueue,
  setWheelHandoffDrain,
  waitForWheelHandoffDrain,
  type WheelBatch,
} from "../src/cdp/wheel-queue.ts";
import type { MouseEventInit } from "@kitesurf/jsrpc-types/page-script";
import type { BrowserState } from "../src/cdp/types.ts";

function wheel(deltaY: number, clientX = 10, shiftKey = false): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY: 10,
    button: 0,
    buttons: 0,
    detail: 0,
    deltaX: 0,
    deltaY,
    deltaZ: 0,
    deltaMode: 0,
    shiftKey,
  };
}

function record(queue: WheelQueue): WheelBatch[] {
  const batches: WheelBatch[] = [];
  queue.configure(async (batch) => {
    batches.push(batch);
    for (const resolve of batch.pending) resolve();
  });
  return batches;
}

describe("WheelQueue", () => {
  it("coalesces compatible input behind the in-flight batch", async () => {
    const queue = new WheelQueue();
    const batches = record(queue);
    const first = queue.enqueue(wheel(10));
    const second = queue.enqueue(wheel(20));
    const third = queue.enqueue(wheel(30));

    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all([second, third]);

    expect(batches.map((batch) => batch.deltaY)).toEqual([10, 50]);
  });

  it("dispatches immediately after the queue goes idle", async () => {
    const queue = new WheelQueue();
    const batches = record(queue);

    await queue.enqueue(wheel(10));
    await Promise.resolve();
    const next = queue.enqueue(wheel(20));
    await Promise.resolve();

    expect(batches.map((batch) => batch.deltaY)).toEqual([10, 20]);
    await next;
  });

  it("keeps incompatible batches in FIFO order", async () => {
    const queue = new WheelQueue();
    const batches = record(queue);
    const replies = [
      queue.enqueue(wheel(10)),
      queue.enqueue(wheel(20, 11)),
      queue.enqueue(wheel(30, 11, true)),
    ];

    await replies[0];
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(replies);

    expect(batches.map((batch) => batch.deltaY)).toEqual([10, 20, 30]);
  });

  it("keeps button-state changes in separate batches", async () => {
    const queue = new WheelQueue();
    const batches = record(queue);
    const replies = [
      queue.enqueue({ ...wheel(10), button: 0, buttons: 1 }),
      queue.enqueue({ ...wheel(20), button: 0, buttons: 1 }),
      queue.enqueue({ ...wheel(30), button: 2, buttons: 1 }),
      queue.enqueue({ ...wheel(40), button: 2, buttons: 0 }),
    ];

    await replies[0];
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.all(replies);

    expect(batches.map((batch) => batch.deltaY)).toEqual([10, 20, 30, 40]);
  });

  it("yields between queued batches", async () => {
    const queue = new WheelQueue();
    const batches = record(queue);
    const first = queue.enqueue(wheel(10));
    const second = queue.enqueue(wheel(20, 11));

    await first;
    expect(batches.map((batch) => batch.deltaY)).toEqual([10]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await second;
    expect(batches.map((batch) => batch.deltaY)).toEqual([10, 20]);
  });

  it("settles queued input when cancelled", async () => {
    const queue = new WheelQueue();
    let release!: () => void;
    queue.configure(async (batch) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      for (const resolve of batch.pending) resolve();
    });

    const first = queue.enqueue(wheel(10));
    const second = queue.enqueue(wheel(20));
    const cancelled = queue.cancel();

    await second;
    release();
    await Promise.all([first, cancelled]);
    expect(queue.isCancelled).toBe(true);
  });

  it("drains accepted input when stopped", async () => {
    const queue = new WheelQueue();
    const batches: WheelBatch[] = [];
    let release!: () => void;
    let waitForDispatch = true;
    queue.configure(async (batch) => {
      batches.push(batch);
      if (waitForDispatch) {
        waitForDispatch = false;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      for (const resolve of batch.pending) resolve();
    });

    const first = queue.enqueue(wheel(10));
    const second = queue.enqueue(wheel(20));
    const stopped = queue.stop();

    await Promise.resolve();
    release();
    await Promise.all([first, second, stopped]);
    expect(batches.map((batch) => batch.deltaY)).toEqual([10, 20]);
  });

  it("fences later input behind the fenced event", async () => {
    const queue = new WheelQueue();
    const batches = record(queue);
    const first = queue.enqueue(wheel(10));
    const release = await queue.fence();
    const later = queue.enqueue(wheel(20));

    expect(batches.map((batch) => batch.deltaY)).toEqual([10]);
    expect(queue.isAccepting).toBe(true);
    let laterSettled = false;
    void later.then(() => {
      laterSettled = true;
    });
    await Promise.resolve();
    expect(laterSettled).toBe(false);

    if (!release) throw new Error("fence was cancelled");
    release();
    await Promise.all([first, later]);
    expect(batches.map((batch) => batch.deltaY)).toEqual([10, 20]);
  });

  it("cancels a queued fence without hanging its caller", async () => {
    const queue = new WheelQueue();
    let releaseDispatch!: () => void;
    queue.configure(async (batch) => {
      await new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
      for (const resolve of batch.pending) resolve();
    });
    const first = queue.enqueue(wheel(10));
    const fence = queue.fence();
    const cancelled = queue.cancel();

    expect(await fence).toBeNull();
    releaseDispatch();
    await Promise.all([first, cancelled]);
  });

  it("does not queue a fence after cancellation", async () => {
    const queue = new WheelQueue();
    await queue.cancel();

    await expect(queue.fence()).resolves.toBeNull();
  });

  it("drains a fence after stopping", async () => {
    const queue = new WheelQueue();
    let releaseDispatch!: () => void;
    queue.configure(async (batch) => {
      await new Promise<void>((resolve) => {
        releaseDispatch = resolve;
      });
      for (const resolve of batch.pending) resolve();
    });

    const first = queue.enqueue(wheel(10));
    const stopped = queue.stop();
    const fence = queue.fence();
    releaseDispatch();
    const releaseFence = await fence;
    expect(releaseFence).not.toBeNull();
    releaseFence?.();
    await Promise.all([first, stopped]);
  });

  it("keeps an active fence held until its owner releases it", async () => {
    const queue = new WheelQueue();
    record(queue);
    const release = await queue.fence();
    expect(release).not.toBeNull();
    if (!release) throw new Error("fence was cancelled");
    const cancelled = queue.cancel();
    const cancelledEarly = await Promise.race([
      cancelled.then(() => false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 0)),
    ]);
    expect(cancelledEarly).toBe(true);

    release();
    await cancelled;
  });

  it("a new owner's flush waits for the former owner's accepted work", async () => {
    const browser = {} as BrowserState;
    const targetId = "target";
    const former = getWheelQueue(browser, targetId, "session-a");
    const successor = getWheelQueue(browser, targetId, "session-c");
    const dispatched: number[] = [];
    let release!: () => void;
    former.configure(async (batch) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      for (const resolve of batch.pending) resolve();
      dispatched.push(batch.deltaY);
    });
    const accepted = former.enqueue(wheel(10));
    moveWheelQueue(browser, targetId, "session-a", "session-c", former);
    const drain = former.stop();

    let flushDone = false;
    const flush = flushWheelQueues(browser, targetId, "session-c", successor).then(() => {
      flushDone = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(flushDone, "the new owner's flush waits for the former drain").toBe(false);
    expect(dispatched, "the accepted batch has not dispatched yet").toEqual([]);

    release();
    await Promise.all([accepted, drain, flush]);
    expect(dispatched).toEqual([10]);
    expect(flushDone).toBe(true);
  });

  it("a successor's flush waits for every predecessor queue moved at takeover", async () => {
    const browser = {} as BrowserState;
    const targetId = "target";
    const dispatched: number[] = [];
    const releases: Record<string, () => void> = {};
    const holdQueue = (queue: WheelQueue, key: string) => {
      queue.configure(async (batch) => {
        await new Promise<void>((resolve) => {
          releases[key] = resolve;
        });
        for (const resolve of batch.pending) resolve();
        dispatched.push(batch.deltaY);
      });
    };

    const qA = getWheelQueue(browser, targetId, "session-a");
    holdQueue(qA, "A");
    const acceptedA = qA.enqueue(wheel(10));
    moveWheelQueue(browser, targetId, "session-a", "session-b", qA);
    const drainA = qA.stop();

    const qB = getWheelQueue(browser, targetId, "session-b");
    expect(qB).not.toBe(qA);
    holdQueue(qB, "B");
    const acceptedB = qB.enqueue(wheel(20));

    const bSlot = [...findWheelQueues(browser, targetId, "session-b")];
    expect(bSlot).toEqual([qB, qA]);
    for (const q of bSlot) {
      moveWheelQueue(browser, targetId, "session-b", "session-c", q);
    }
    const drains = bSlot.map((q) => q.stop());

    const qC = getWheelQueue(browser, targetId, "session-c");
    expect(qC).not.toBe(qA);
    expect(qC).not.toBe(qB);
    expect(qC.isAccepting).toBe(true);
    const cSlot = findWheelQueues(browser, targetId, "session-c");
    expect(cSlot).toContain(qB);
    expect(cSlot).toContain(qA);
    expect(cSlot).toContain(qC);

    let flushDone = false;
    const flush = flushWheelQueues(browser, targetId, "session-c", qC).then(() => {
      flushDone = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(flushDone, "the successor's flush waits for the predecessor drains").toBe(false);
    releases.B!();
    await Promise.resolve();
    await Promise.resolve();
    expect(flushDone, "the successor's flush still waits for A's drain").toBe(false);
    releases.A!();
    await Promise.all([acceptedA, acceptedB, drainA, ...drains, flush]);
    expect(dispatched).toEqual([20, 10]);
    expect(flushDone).toBe(true);
  });

  it("an older cyclic-takeover drain cannot remove a newer barrier", async () => {
    const browser = { screencasts: new Map() } as BrowserState;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstDrain = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondDrain = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const firstBarrier = setWheelHandoffDrain(browser, "target", "session-a", firstDrain);
    const secondBarrier = setWheelHandoffDrain(browser, "target", "session-a", secondDrain);

    let waitDone = false;
    const wait = waitForWheelHandoffDrain(browser, "target", "session-a").then(() => {
      waitDone = true;
    });
    releaseFirst();
    await firstBarrier;
    await Promise.resolve();
    expect(
      waitDone,
      "a waiter already parked on the older barrier continues through the newer barrier",
    ).toBe(false);

    browser.screencasts.clear();
    releaseSecond();
    await Promise.all([secondBarrier, wait]);
    expect(waitDone).toBe(true);
  });

  it("navigation cancels every target queue across session slots", async () => {
    const browser = {} as BrowserState;
    const targetId = "target";
    const dispatched: number[] = [];
    let releaseOwner!: () => void;
    let releaseFormer!: () => void;
    let releaseLate!: () => void;
    const q1 = getWheelQueue(browser, targetId, "session-a");
    q1.configure(async (batch) => {
      await new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
      for (const resolve of batch.pending) resolve();
      dispatched.push(batch.deltaY);
    });
    const inFlightOwner = q1.enqueue(wheel(10));
    const queuedOwner = q1.enqueue(wheel(20, 11));
    moveWheelQueue(browser, targetId, "session-a", "session-b", q1);
    q1.stop();

    const q2 = getWheelQueue(browser, targetId, "session-c");
    q2.configure(async (batch) => {
      await new Promise<void>((resolve) => {
        releaseFormer = resolve;
      });
      for (const resolve of batch.pending) resolve();
      dispatched.push(batch.deltaY);
    });
    const inFlightFormer = q2.enqueue(wheel(30));
    const queuedFormer = q2.enqueue(wheel(40, 12));

    const cancelled = cancelAndRemoveTargetWheelQueues(browser, targetId);
    expect(q1.isCancelled, "the owner-slot predecessor is cancelled").toBe(true);
    expect(q2.isCancelled, "the former-slot predecessor is cancelled").toBe(true);
    await expect(queuedOwner).resolves.toBeUndefined();
    await expect(queuedFormer).resolves.toBeUndefined();

    const qLate = getWheelQueue(browser, targetId, "session-d");
    qLate.configure(async (batch) => {
      await new Promise<void>((resolve) => {
        releaseLate = resolve;
      });
      for (const resolve of batch.pending) resolve();
      dispatched.push(batch.deltaY);
    });
    const inFlightLate = qLate.enqueue(wheel(50));
    const queuedLate = qLate.enqueue(wheel(60, 13));

    releaseOwner();
    releaseFormer();
    const lateQueuedSettled = await Promise.race([
      queuedLate.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    expect(lateQueuedSettled, "the late queue's queued batch is cancelled").toBe(true);
    expect(qLate.isCancelled, "the late-created queue is cancelled").toBe(true);

    releaseLate();
    await Promise.all([
      inFlightOwner,
      queuedOwner,
      inFlightFormer,
      queuedFormer,
      inFlightLate,
      queuedLate,
      cancelled,
    ]);
    expect(findWheelQueues(browser, targetId, "session-b")).toEqual([]);
    expect(findWheelQueues(browser, targetId, "session-c")).toEqual([]);
    expect(findWheelQueues(browser, targetId, "session-d")).toEqual([]);
    expect(dispatched).toEqual([10, 30, 50]);
  });
});
