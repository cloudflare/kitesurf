// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Serializes per-target wheel events during scrolling and frame handoff.

import type { BrowserState } from "./types.ts";

import type { MouseEventInit } from "@kitesurf/jsrpc-types/page-script";

export interface WheelBatch {
  init: MouseEventInit;
  deltaX: number;
  deltaY: number;
  pending: Array<() => void>;
}

type WheelDispatch = (batch: WheelBatch, queue: WheelQueue) => Promise<void>;

interface WheelFence {
  kind: "fence";
  ready: (release: (() => void) | null) => void;
  released: Promise<void>;
  release: () => void;
}

type QueueItem = WheelBatch | WheelFence;

export class WheelQueue {
  #lifecycle: "accepting" | "stopping" | "cancelled" = "accepting";
  #batches: QueueItem[] = [];
  #draining: Promise<void> | null = null;
  #scheduled: ReturnType<typeof setTimeout> | null = null;
  #dispatch: WheelDispatch | null = null;

  get isCancelled(): boolean {
    return this.#lifecycle === "cancelled";
  }

  get isAccepting(): boolean {
    return this.#lifecycle === "accepting";
  }

  configure(dispatch: WheelDispatch): void {
    this.#dispatch ??= dispatch;
  }

  enqueue(init: MouseEventInit): Promise<void> {
    if (!this.isAccepting) return Promise.resolve();
    return this.#enqueueAccepted(init);
  }

  #enqueueAccepted(init: MouseEventInit): Promise<void> {
    const batch = this.#coalesceOrCreate(init);
    batch.deltaX += typeof init.deltaX === "number" ? init.deltaX : 0;
    batch.deltaY += typeof init.deltaY === "number" ? init.deltaY : 0;
    const reply = new Promise<void>((resolve) => batch.pending.push(resolve));
    if (!this.#draining && this.#scheduled === null) void this.#drain();
    return reply;
  }

  #coalesceOrCreate(init: MouseEventInit): WheelBatch {
    const last = this.#batches[this.#batches.length - 1];
    let batch = last && "kind" in last ? undefined : last;
    if (!batch || !canCoalesceWheel(batch.init, init)) {
      batch = { init, deltaX: 0, deltaY: 0, pending: [] };
      this.#batches.push(batch);
    } else {
      batch.init = init;
    }
    return batch;
  }

  async fence(): Promise<(() => void) | null> {
    if (this.isCancelled) return null;
    let resolveReady!: (release: (() => void) | null) => void;
    let resolveReleased!: () => void;
    let released = false;
    const releasedPromise = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    const fence: WheelFence = {
      kind: "fence",
      ready: (release) => resolveReady(release),
      released: releasedPromise,
      release: () => {
        if (released) return;
        released = true;
        resolveReleased();
      },
    };
    const ready = new Promise<(() => void) | null>((resolve) => {
      resolveReady = resolve;
    });
    this.#batches.push(fence);
    if (!this.#draining && this.#scheduled === null) void this.#drain();
    return ready;
  }

  async flush(): Promise<void> {
    if (!this.#draining && this.#batches.length === 0) return;
    this.#clearScheduled();
    await this.#drainUntilIdle();
  }

  async #drainUntilIdle(): Promise<void> {
    while (this.#draining || this.#batches.length > 0) await this.#drainStep();
  }

  async #drainStep(): Promise<void> {
    if (this.#draining) await this.#draining;
    if (this.#batches.length > 0) await this.#drain();
  }

  async stop(): Promise<void> {
    if (this.#lifecycle === "accepting") this.#lifecycle = "stopping";
    await this.flush();
  }

  async cancel(): Promise<void> {
    this.#lifecycle = "cancelled";
    this.#clearScheduled();
    this.#batches.splice(0).forEach((item) => {
      if ("kind" in item) {
        item.ready(null);
        item.release();
      } else settle(item);
    });
    await this.#draining;
  }

  #scheduleDrain(): void {
    if (
      this.#scheduled !== null ||
      this.isCancelled ||
      this.#draining ||
      this.#batches.length === 0
    )
      return;
    this.#scheduled = setTimeout(() => {
      this.#scheduled = null;
      void this.#drain();
    }, 0);
  }

  #clearScheduled(): void {
    if (this.#scheduled !== null) {
      clearTimeout(this.#scheduled);
      this.#scheduled = null;
    }
  }

  #drain(): Promise<void> {
    if (this.#draining) return this.#draining;
    const item = this.#batches.shift();
    if (!item) return Promise.resolve();

    const run = (async () => {
      try {
        if ("kind" in item) {
          item.ready(item.release);
          await item.released;
        } else if (this.#dispatch) {
          await this.#dispatch(item, this);
        } else {
          settle(item);
        }
      } catch {
        if (!("kind" in item)) settle(item);
      }
    })();
    this.#draining = run;
    void run.then(() => {
      if (this.#draining !== run) return;
      this.#draining = null;
      this.#scheduleDrain();
    });
    return run;
  }
}

type QueueStore = Map<string, WheelQueue[]>;

const stores = new WeakMap<BrowserState, QueueStore>();
const handoffStores = new WeakMap<BrowserState, Map<string, Promise<void>>>();

function key(targetId: string, sessionId: string | undefined): string {
  return `${targetId}\u0000${sessionId || ""}`;
}

function queuesFor(
  browser: BrowserState,
  targetId: string,
  sessionId: string | undefined,
  create: boolean,
): WheelQueue[] {
  const store = queueStoreFor(browser, create);
  if (!store) return [];
  const queueKey = key(targetId, sessionId);
  return queuesFromStore(store, queueKey, create);
}

function queueStoreFor(browser: BrowserState, create: boolean): QueueStore | undefined {
  let store = stores.get(browser);
  if (store || !create) return store;
  store = new Map();
  stores.set(browser, store);
  return store;
}

function queuesFromStore(store: QueueStore, queueKey: string, create: boolean): WheelQueue[] {
  let queues = store.get(queueKey);
  if (!queues && create) {
    queues = [];
    store.set(queueKey, queues);
  }
  return queues ?? [];
}

export function getWheelQueue(
  browser: BrowserState,
  targetId: string,
  sessionId: string | undefined,
): WheelQueue {
  const queues = queuesFor(browser, targetId, sessionId, true);
  const current = queues[queues.length - 1];
  if (current?.isAccepting) return current;
  const queue = new WheelQueue();
  queues.push(queue);
  return queue;
}

export function findWheelQueues(
  browser: BrowserState,
  targetId: string,
  sessionId: string | undefined,
): WheelQueue[] {
  return queuesFor(browser, targetId, sessionId, false);
}

export function removeWheelQueue(
  browser: BrowserState,
  targetId: string,
  sessionId: string | undefined,
  queue: WheelQueue,
): void {
  const store = stores.get(browser);
  if (!store) return;
  const queueKey = key(targetId, sessionId);
  const queues = store.get(queueKey);
  if (!queues) return;
  removeFromQueueList(queues, queue);
  deleteEmptyQueueList(store, queueKey, queues);
}

export function moveWheelQueue(
  browser: BrowserState,
  targetId: string,
  fromSessionId: string | undefined,
  toSessionId: string | undefined,
  queue: WheelQueue,
): void {
  const store = stores.get(browser);
  if (!store) return;
  const fromKey = key(targetId, fromSessionId);
  removeQueueFromStore(store, fromKey, queue);
  const toKey = key(targetId, toSessionId);
  addQueueToStore(store, toKey, queue);
}

export function stopAndRemoveWheelQueue(
  browser: BrowserState,
  targetId: string,
  sessionId: string | undefined,
  queue: WheelQueue,
): void {
  const remove = () => removeWheelQueue(browser, targetId, sessionId, queue);
  void queue.stop().then(remove, remove);
}

export async function cancelAndRemoveTargetWheelQueues(
  browser: BrowserState,
  targetId: string,
): Promise<void> {
  const store = stores.get(browser);
  if (!store) return;
  const prefix = `${targetId}\u0000`;
  while (await cancelTargetQueueBatch(store, prefix)) {}
}

export async function flushWheelQueues(
  browser: BrowserState,
  targetId: string,
  sessionId: string | undefined,
  except?: WheelQueue,
): Promise<void> {
  for (const queue of [...findWheelQueues(browser, targetId, sessionId)]) {
    if (queue !== except) await queue.flush();
  }
}

export async function fenceWheelQueues(
  browser: BrowserState,
  targetId: string,
  sessionId: string | undefined,
): Promise<Array<() => void> | null> {
  const releases = await Promise.all(
    findWheelQueues(browser, targetId, sessionId).map((queue) => queue.fence()),
  );
  if (releases.some((release) => release === null)) {
    for (const release of releases) release?.();
    return null;
  }
  return releases as Array<() => void>;
}

export function setWheelHandoffDrain(
  browser: BrowserState,
  targetId: string,
  sessionId: string | undefined,
  drain: Promise<unknown>,
): Promise<void> {
  let barriers = handoffStores.get(browser);
  if (!barriers) {
    barriers = new Map();
    handoffStores.set(browser, barriers);
  }
  const sessionKey = key(targetId, sessionId);
  let barrier: Promise<void>;
  barrier = drain.then(() => {
    if (barriers.get(sessionKey) === barrier) barriers.delete(sessionKey);
    if (barriers.size === 0) handoffStores.delete(browser);
  });
  barriers.set(sessionKey, barrier);
  return barrier;
}

export async function waitForWheelHandoffDrain(
  browser: BrowserState,
  targetId: string,
  sessionId: string | undefined,
): Promise<void> {
  for (;;) {
    const barrier = handoffStores.get(browser)?.get(key(targetId, sessionId));
    if (!barrier) return;
    await barrier;
  }
}

function canCoalesceWheel(previous: MouseEventInit, next: MouseEventInit): boolean {
  return (
    sameWheelModifiers(previous, next) &&
    sameWheelPosition(previous, next) &&
    sameWheelButtons(previous, next) &&
    previous.deltaMode === next.deltaMode
  );
}

function sameWheelModifiers(previous: MouseEventInit, next: MouseEventInit): boolean {
  return (
    previous.altKey === next.altKey &&
    previous.ctrlKey === next.ctrlKey &&
    previous.metaKey === next.metaKey &&
    previous.shiftKey === next.shiftKey
  );
}

function sameWheelPosition(previous: MouseEventInit, next: MouseEventInit): boolean {
  return previous.clientX === next.clientX && previous.clientY === next.clientY;
}

function sameWheelButtons(previous: MouseEventInit, next: MouseEventInit): boolean {
  return previous.button === next.button && previous.buttons === next.buttons;
}

function removeFromQueueList(queues: WheelQueue[], queue: WheelQueue): void {
  const index = queues.indexOf(queue);
  if (index !== -1) queues.splice(index, 1);
}

function deleteEmptyQueueList(store: QueueStore, queueKey: string, queues: WheelQueue[]): void {
  if (queues.length === 0) store.delete(queueKey);
}

function removeQueueFromStore(store: QueueStore, queueKey: string, queue: WheelQueue): void {
  const queues = store.get(queueKey);
  if (!queues) return;
  removeFromQueueList(queues, queue);
  deleteEmptyQueueList(store, queueKey, queues);
}

function addQueueToStore(store: QueueStore, queueKey: string, queue: WheelQueue): void {
  let queues = store.get(queueKey);
  if (!queues) {
    queues = [];
    store.set(queueKey, queues);
  }
  if (!queues.includes(queue)) queues.push(queue);
}

async function cancelTargetQueueBatch(store: QueueStore, prefix: string): Promise<boolean> {
  const queues = collectTargetQueues(store, prefix);
  if (queues.size === 0) return false;
  await Promise.all([...queues].map((queue) => queue.cancel()));
  removeTargetQueues(store, prefix, queues);
  return true;
}

function collectTargetQueues(store: QueueStore, prefix: string): Set<WheelQueue> {
  const queues = new Set<WheelQueue>();
  for (const [queueKey, slot] of store) {
    if (queueKey.startsWith(prefix)) addQueues(queues, slot);
  }
  return queues;
}

function addQueues(queues: Set<WheelQueue>, slot: WheelQueue[]): void {
  for (const queue of slot) queues.add(queue);
}

function removeTargetQueues(store: QueueStore, prefix: string, queues: Set<WheelQueue>): void {
  for (const [queueKey, slot] of store) {
    if (!queueKey.startsWith(prefix)) continue;
    removeMatchingQueues(slot, queues);
    if (slot.length === 0) store.delete(queueKey);
  }
}

function removeMatchingQueues(slot: WheelQueue[], queues: Set<WheelQueue>): void {
  for (let i = slot.length - 1; i >= 0; i--) {
    const queue = slot[i];
    if (queue && queues.has(queue)) slot.splice(i, 1);
  }
}

function settle(batch: WheelBatch): void {
  for (const resolve of batch.pending) resolve();
}
