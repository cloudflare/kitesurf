// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Schedules page timers, animation frames, idle callbacks, and port tasks.
// Timers attach to the session's IoContext, so they fire after a method reply; the post-load
// `setTimeout(0)` drain runs before load settles.

import { notePaintWake } from "./internal-state.js";
import {
  setAnimationTaskScheduler,
  setModelContextTaskScheduler,
  setWrapperSweepScheduler,
} from "./dom-shim.js";
import {
  installIntersectionObserver,
  recheckIntersectionObservers,
} from "./intersection-observer.ts";
import { ks_bridge_ever_minted, ks_run_page_jobs } from "./wasm-glue.js";
import { drainSettleMicrotasks, isEngineScheduling, NativePromise } from "./native-scheduling.ts";
import { ksGlobal } from "./state.ts";
import type { ShimWindow } from "./types.ts";

const nativeTimerNow =
  typeof ksGlobal.performance?.now === "function"
    ? ksGlobal.performance.now.bind(ksGlobal.performance)
    : ksGlobal.Date.now.bind(ksGlobal.Date);

const rafQueue = new Map<number, (ts: number) => void>();
let rafNextId = 1;
let rafTimer: ReturnType<typeof setTimeout> | null = null;
let activeTimerDeadline: number | undefined;
const RAF_FRAME_MS = 16;
const RAF_FRAME_SLACK_MS = 4;
const RAF_BACKSTOP_STALE_MS = 1_000;

const IDLE_CALLBACK_BUDGET_MS = 50;

let rafNextFrameAt = 0;
let rafBatchDueAt = 0;
const RAF_DRIVER_GRACE = 2;
const RAF_DRIVER_MAX_INTERVAL_MS = 1000;
let rafDriverIntervalMs = 0;
let rafDriverPumpAt = 0;
let rafDriverTurn = false;

export function beginRafDriverTurn(intervalMs: number): void {
  rafDriverIntervalMs = Math.min(
    RAF_DRIVER_MAX_INTERVAL_MS,
    Math.max(RAF_FRAME_MS, intervalMs | 0),
  );
  rafDriverPumpAt = Date.now();
  rafDriverTurn = true;
}

export function endRafDriverTurn(): void {
  rafDriverTurn = false;
}

function rafDriven(): boolean {
  return Date.now() - rafDriverPumpAt < rafDriverIntervalMs * RAF_DRIVER_GRACE;
}

function rafBackstopMs(): number {
  return rafDriven() ? rafDriverIntervalMs * RAF_DRIVER_GRACE : RAF_FRAME_MS;
}

let lastPumpMs = 0;
let rafArmedAt = 0;
const RAF_PUMP_BUDGET_MS = 250;
let engineSetTimeout:
  | ((callback: (...callbackArgs: any[]) => void, delayMs?: number, ...callbackArgs: any[]) => any)
  | null = null;
let engineClearTimeout: ((id: any) => void) | null = null;

function scheduleRafBackstop(): void {
  if (rafQueue.size === 0) return;
  const delay = Math.max(rafBackstopMs(), lastPumpMs * 2);
  if (hasFreshRafBackstop(delay)) return;
  clearRafTimer();
  rafArmedAt = Date.now();
  rafTimer = (engineSetTimeout ?? setTimeout)(() => {
    rafTimer = null;
    pumpAnimationFrames(activeTimerDeadline);
  }, delay);
}

function hasFreshRafBackstop(delay: number): boolean {
  return rafTimer !== null && Date.now() - rafArmedAt <= delay + RAF_BACKSTOP_STALE_MS;
}

function clearRafTimer(): void {
  if (rafTimer === null) return;
  try {
    (engineClearTimeout ?? clearTimeout)(rafTimer);
  } catch {}
  rafTimer = null;
}

export function hasPendingAnimationFrames(): boolean {
  return rafQueue.size > 0;
}

function rafFrameDueAt(): number {
  return rafDriverTurn ? rafBatchDueAt : rafNextFrameAt;
}

export function pumpAnimationFrames(deadlineMs?: number): number {
  if (rafQueue.size === 0) return 0;
  if (shouldDeferAnimationFrame()) {
    scheduleRafBackstop();
    return 0;
  }

  rafDriverTurn = false;
  // Snapshot handles so callbacks queued during this batch wait for a later batch.
  // Each handle is removed before its callback runs, matching HTML's cancellation/requeue order.
  // https://html.spec.whatwg.org/#run-the-animation-frame-callbacks
  const frameCallbackIds = [...rafQueue.keys()];
  clearRafTimer();
  const pumpStartedAt = Date.now();
  const deadline = deadlineMs ?? pumpStartedAt + RAF_PUMP_BUDGET_MS;
  const batch = runRafCallbacks(frameCallbackIds, deadline, performance.now());
  advanceRafFrameClock(pumpStartedAt, batch.stoppedByDeadline);
  recheckIntersectionObservers("frame");
  lastPumpMs = Date.now() - pumpStartedAt;
  scheduleRafBackstop();
  return batch.callbacksRun;
}

function shouldDeferAnimationFrame(): boolean {
  return (rafDriven() && !rafDriverTurn) || Date.now() < rafFrameDueAt();
}

interface RafCallbackBatch {
  callbacksRun: number;
  stoppedByDeadline: boolean;
}

function runRafCallbacks(ids: number[], deadline: number, timestamp: number): RafCallbackBatch {
  let callbacksRun = 0;
  for (let index = 0; index < ids.length; index++) {
    if (Date.now() >= deadline) return { callbacksRun, stoppedByDeadline: true };
    if (runRafCallback(ids[index]!, timestamp)) callbacksRun++;
  }
  return { callbacksRun, stoppedByDeadline: false };
}

function runRafCallback(id: number, timestamp: number): boolean {
  const callback = rafQueue.get(id);
  if (callback === undefined) return false;
  rafQueue.delete(id);
  try {
    callback(timestamp);
    return true;
  } catch (error) {
    try {
      console.error("[kitesurf] rAF callback threw:", error);
    } catch {}
    return false;
  }
}

function advanceRafFrameClock(pumpStartedAt: number, stoppedByDeadline: boolean): void {
  if (stoppedByDeadline) return;
  const nextFromStart = pumpStartedAt + RAF_FRAME_MS - RAF_FRAME_SLACK_MS;
  const frameEndedAt = Date.now();
  rafBatchDueAt = frameEndedAt < nextFromStart ? nextFromStart : frameEndedAt + RAF_FRAME_MS;
  if (rafQueue.size > 0) rafNextFrameAt = rafBatchDueAt;
}

interface WheelEntry {
  id: number;
  order: number;
  callback: (...callbackArgs: unknown[]) => void;
  callbackArgs: unknown[];
  due: number;
  delay: number;
  repeats: boolean;
}

const timerWheel = new Map<number, WheelEntry>();
const timerWheelHeap: WheelEntry[] = [];
let timerWheelWake: number | null = null;
let timerWheelWakeDue = Infinity;

const MAX_NATIVE_TIMER_DELAY = 2_147_483_647;

const FIRST_PAGE_TIMER_ID = 1_000_000_000;
const MAX_PAGE_TIMER_ID = 2_147_483_647;
const TIMER_ID_MODULO = 4_294_967_296;
const TIMER_ID_SIGNED_BOUNDARY = 2_147_483_648;

const TIMER_HEAP_COMPACT_MIN_ENTRIES = 1_024;
const TIMER_HEAP_COMPACT_FACTOR = 2;
const runningTimerIds = new Set<number>();
const cancelledTimerIds = new Set<number>();

let timerWheelNextId = FIRST_PAGE_TIMER_ID;
let timerWheelNextOrder = 0;

let pageTimerSchedules = 0;
let nativeTimerFunctions: {
  setTimeout: (callback: (...callbackArgs: unknown[]) => void, delay?: number) => number;
  clearTimeout: (timerId: number) => void;
  clearInterval: ((timerId: number) => void) | null;
} | null = null;

let timerWheelWakesFired = 0;
let timerWheelWakesArmed = 0;

function timerPrecedes(leftEntry: WheelEntry, rightEntry: WheelEntry): boolean {
  return (
    leftEntry.due < rightEntry.due ||
    (leftEntry.due === rightEntry.due && leftEntry.order < rightEntry.order)
  );
}

function pushTimerWheelEntry(entry: WheelEntry): void {
  let index = timerWheelHeap.length;
  timerWheelHeap.push(entry);
  while (index > 0) {
    const parent = (index - 1) >> 1;
    const parentEntry = timerWheelHeap[parent];
    if (!parentEntry || !timerPrecedes(entry, parentEntry)) break;
    timerWheelHeap[index] = parentEntry;
    index = parent;
  }
  timerWheelHeap[index] = entry;
}

function popTimerWheelEntry(): WheelEntry | undefined {
  const first = timerWheelHeap[0];
  const last = timerWheelHeap.pop();
  if (!first || first === last) return first;
  if (last) siftTimerWheelEntryDown(last);
  return first;
}

function siftTimerWheelEntryDown(last: WheelEntry): void {
  let index = 0;
  while (true) {
    const child = timerWheelChildIndex(index);
    if (child === undefined) break;
    const childEntry = timerWheelHeap[child];
    if (!childPrecedesTimerWheelEntry(childEntry, last)) break;
    timerWheelHeap[index] = childEntry;
    index = child;
  }
  timerWheelHeap[index] = last;
}

function timerWheelChildIndex(index: number): number | undefined {
  const left = index * 2 + 1;
  if (left >= timerWheelHeap.length) return undefined;
  const right = left + 1;
  const leftEntry = timerWheelHeap[left];
  if (!leftEntry) return undefined;
  const rightEntry = timerWheelHeap[right];
  if (rightTimerWheelChildPrecedes(right, rightEntry, leftEntry)) return right;
  return left;
}

function rightTimerWheelChildPrecedes(
  right: number,
  rightEntry: WheelEntry | undefined,
  leftEntry: WheelEntry,
): boolean {
  return right < timerWheelHeap.length && !!rightEntry && timerPrecedes(rightEntry, leftEntry);
}

function childPrecedesTimerWheelEntry(
  child: WheelEntry | undefined,
  parent: WheelEntry,
): child is WheelEntry {
  return !!child && timerPrecedes(child, parent);
}

function nextTimerWheelEntry(): WheelEntry | undefined {
  let nextEntry = timerWheelHeap[0];
  while (nextEntry && timerWheel.get(nextEntry.id) !== nextEntry) {
    popTimerWheelEntry();
    nextEntry = timerWheelHeap[0];
  }
  return nextEntry;
}

function compactTimerWheelHeap(): void {
  if (
    timerWheelHeap.length <=
    Math.max(TIMER_HEAP_COMPACT_MIN_ENTRIES, timerWheel.size * TIMER_HEAP_COMPACT_FACTOR)
  )
    return;
  timerWheelHeap.length = 0;
  for (const entry of timerWheel.values()) pushTimerWheelEntry(entry);
}

function armTimerWheelWake(): void {
  const capturedTimers = nativeTimerFunctions;
  if (!capturedTimers) return;
  const nextEntry = nextTimerWheelEntry();
  if (!nextEntry) {
    clearUnusedTimerWheelWake(capturedTimers);
    return;
  }
  const currentTimeMs = nativeTimerNow();
  const delay = Math.min(MAX_NATIVE_TIMER_DELAY, Math.max(0, nextEntry.due - currentTimeMs));
  const wakeDue = currentTimeMs + delay;
  if (timerWakeAlreadyCovers(wakeDue)) return;
  const previousWake = timerWheelWake;
  const previousWakeDue = timerWheelWakeDue;
  const scheduled = scheduleTimerWheelWakeWithFallback(
    capturedTimers,
    delay,
    previousWake,
    previousWakeDue,
  );
  timerWheelWake = scheduled.id;
  timerWheelWakeDue = wakeDue;
  clearReplacedTimerWheelWake(capturedTimers, previousWake, scheduled.previousWakeCleared);
}

function clearReplacedTimerWheelWake(
  timers: NonNullable<typeof nativeTimerFunctions>,
  previousWake: number | null,
  previousWakeCleared: boolean,
): void {
  if (previousWake === null || previousWakeCleared) return;
  clearTimerWheelWake(timers, previousWake);
}

function clearUnusedTimerWheelWake(timers: NonNullable<typeof nativeTimerFunctions>): void {
  if (timerWheelWake !== null) clearTimerWheelWake(timers, timerWheelWake);
  timerWheelWake = null;
  timerWheelWakeDue = Infinity;
}

function clearTimerWheelWake(timers: NonNullable<typeof nativeTimerFunctions>, id: number): void {
  try {
    timers.clearTimeout(id);
  } catch {}
}

function timerWakeAlreadyCovers(wakeDue: number): boolean {
  return timerWheelWake !== null && timerWheelWakeDue <= wakeDue;
}

function createTimerWheelWake(
  timers: NonNullable<typeof nativeTimerFunctions>,
  delay: number,
): number {
  let wakeId = 0;
  timerWheelWakesArmed++;
  wakeId = timers.setTimeout(() => {
    timerWheelWakesFired++;
    if (timerWheelWake !== wakeId) return;
    const wakeDueMs = timerWheelWakeDue;
    timerWheelWake = null;
    timerWheelWakeDue = Infinity;
    pumpDueTimers(undefined, undefined, wakeDueMs);
  }, delay);
  return wakeId;
}

function scheduleTimerWheelWakeWithFallback(
  timers: NonNullable<typeof nativeTimerFunctions>,
  delay: number,
  previousWake: number | null,
  previousWakeDue: number,
): { id: number; previousWakeCleared: boolean } {
  try {
    return { id: createTimerWheelWake(timers, delay), previousWakeCleared: false };
  } catch (error) {
    return retryTimerWheelWakeAfterLimit(timers, delay, previousWake, previousWakeDue, error);
  }
}

function retryTimerWheelWakeAfterLimit(
  timers: NonNullable<typeof nativeTimerFunctions>,
  delay: number,
  previousWake: number | null,
  previousWakeDue: number,
  error: unknown,
): { id: number; previousWakeCleared: boolean } {
  if (previousWake === null || !isActiveTimeoutLimitError(error)) throw error;
  timers.clearTimeout(previousWake);
  timerWheelWake = null;
  timerWheelWakeDue = Infinity;
  return retryTimerWheelWakeAfterClear(timers, delay, previousWakeDue);
}

function isActiveTimeoutLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /too many active timeouts/i.test(message);
}

function retryTimerWheelWakeAfterClear(
  timers: NonNullable<typeof nativeTimerFunctions>,
  delay: number,
  previousWakeDue: number,
): { id: number; previousWakeCleared: boolean } {
  try {
    return { id: createTimerWheelWake(timers, delay), previousWakeCleared: true };
  } catch (retryError) {
    try {
      restoreTimerWheelWake(timers, previousWakeDue);
    } catch {}
    throw retryError;
  }
}

function restoreTimerWheelWake(
  timers: NonNullable<typeof nativeTimerFunctions>,
  previousWakeDue: number,
): void {
  const restoreDelay = Math.min(
    MAX_NATIVE_TIMER_DELAY,
    Math.max(0, previousWakeDue - nativeTimerNow()),
  );
  timerWheelWake = createTimerWheelWake(timers, restoreDelay);
  timerWheelWakeDue = nativeTimerNow() + restoreDelay;
}

function toTimerLong(value: unknown): number {
  if (value === undefined) return 0;
  const number = +(value as number);
  if (!Number.isFinite(number) || number === 0) return 0;
  const modulo = Math.trunc(number) % TIMER_ID_MODULO;
  return signedTimerId(modulo);
}

function signedTimerId(modulo: number): number {
  if (modulo >= TIMER_ID_SIGNED_BOUNDARY) return modulo - TIMER_ID_MODULO;
  if (modulo < -TIMER_ID_SIGNED_BOUNDARY) return modulo + TIMER_ID_MODULO;
  return modulo;
}

function scheduleWheelTimer(
  callback: (...callbackArgs: unknown[]) => void,
  delayValue: unknown,
  callbackArgs: unknown[],
  repeats: boolean,
): number {
  const delay = Math.max(0, toTimerLong(delayValue));
  const timerId = allocateTimerWheelId();
  const timerEntry = createWheelEntry(timerId, callback, callbackArgs, delay, repeats);
  timerWheel.set(timerId, timerEntry);
  pushTimerWheelEntry(timerEntry);
  try {
    armTimerWheelWake();
  } catch (error) {
    rollbackWheelTimer(timerId);
    throw error;
  }
  return timerId;
}

function allocateTimerWheelId(): number {
  while (timerWheel.has(timerWheelNextId) || runningTimerIds.has(timerWheelNextId)) {
    timerWheelNextId = followingTimerWheelId(timerWheelNextId);
  }
  const id = timerWheelNextId;
  timerWheelNextId = followingTimerWheelId(id);
  return id;
}

function followingTimerWheelId(id: number): number {
  return id === MAX_PAGE_TIMER_ID ? FIRST_PAGE_TIMER_ID : id + 1;
}

function createWheelEntry(
  id: number,
  callback: (...callbackArgs: unknown[]) => void,
  callbackArgs: unknown[],
  delay: number,
  repeats: boolean,
): WheelEntry {
  return {
    id,
    order: timerWheelNextOrder++,
    callback,
    callbackArgs,
    due: nativeTimerNow() + delay,
    delay,
    repeats,
  };
}

function rollbackWheelTimer(id: number): void {
  timerWheel.delete(id);
  try {
    armTimerWheelWake();
  } catch {}
}

function clearWheelTimer(id: number): boolean {
  if (timerWheel.delete(id)) {
    compactTimerWheelHeap();
    if (timerWheel.size === 0) armTimerWheelWake();
    return true;
  }
  if (runningTimerIds.has(id)) {
    cancelledTimerIds.add(id);
    return true;
  }
  return false;
}

function coerceWheelCallback(callback: unknown): unknown {
  if (typeof callback !== "string") return callback;
  const source = callback;
  return () => {
    try {
      ksGlobal.eval(source);
    } catch (error) {
      try {
        console.error("[kitesurf] setTimeout/setInterval string-task threw:", error);
      } catch {}
    }
  };
}

function installTimerWheel(): void {
  if (nativeTimerFunctions) return;
  const pageGlobal = ksGlobal;
  const nativeSetTimeout = pageGlobal.setTimeout.bind(pageGlobal);
  const nativeSetInterval = pageGlobal.setInterval.bind(pageGlobal);
  const nativeClearTimeout = pageGlobal.clearTimeout.bind(pageGlobal);
  const nativeClearInterval =
    typeof pageGlobal.clearInterval === "function"
      ? pageGlobal.clearInterval.bind(pageGlobal)
      : null;
  nativeTimerFunctions = {
    setTimeout: nativeSetTimeout,
    clearTimeout: nativeClearTimeout,
    clearInterval: nativeClearInterval,
  };
  pageGlobal.setTimeout = (callback: unknown, delay?: unknown, ...callbackArgs: unknown[]) => {
    if (!isEngineScheduling()) pageTimerSchedules++;
    callback = coerceWheelCallback(callback);
    if (typeof callback !== "function") {
      return nativeSetTimeout(callback as any, delay as any, ...callbackArgs);
    }
    return scheduleWheelTimer(
      callback as (...callbackArgs: unknown[]) => void,
      delay,
      callbackArgs,
      false,
    );
  };
  pageGlobal.setInterval = (callback: unknown, delay?: unknown, ...callbackArgs: unknown[]) => {
    if (!isEngineScheduling()) pageTimerSchedules++;
    callback = coerceWheelCallback(callback);
    if (typeof callback !== "function") {
      return nativeSetInterval(callback as any, delay as any, ...callbackArgs);
    }
    return scheduleWheelTimer(
      callback as (...callbackArgs: unknown[]) => void,
      delay,
      callbackArgs,
      true,
    );
  };
  pageGlobal.clearTimeout = (id: unknown) => {
    const timerId = toTimerLong(id);
    if (clearWheelTimer(timerId)) return;
    if (timerId === timerWheelWake) return;
    nativeClearTimeout(timerId);
  };
  pageGlobal.clearInterval = (id: unknown) => {
    const timerId = toTimerLong(id);
    if (clearWheelTimer(timerId)) return;
    if (timerId === timerWheelWake) return;
    (nativeClearInterval ?? nativeClearTimeout)(timerId);
  };
}

let timerTaskWaiters: Array<() => void> = [];
export function nextTimerTask(): Promise<void> {
  return new NativePromise<void>((resolve) => {
    timerTaskWaiters.push(resolve);
  });
}

export function pumpDueTimers(
  deadlineMs?: number,
  maxRunCount?: number,
  wakeDueMs = -Infinity,
): number {
  if (!canPumpDueTimer(deadlineMs, maxRunCount)) return 0;
  const currentTimeMs = Math.max(nativeTimerNow(), wakeDueMs);
  const timerEntry = nextDueTimer(currentTimeMs);
  if (!timerEntry) return 0;
  clearCurrentTimerWheelWake();
  popTimerWheelEntry();
  timerWheel.delete(timerEntry.id);
  runningTimerIds.add(timerEntry.id);
  runTimerCallback(timerEntry, deadlineMs);
  runPageJobsIfNeeded();
  runningTimerIds.delete(timerEntry.id);
  rescheduleRepeatingTimer(timerEntry);
  armTimerWheelWake();
  notifyTimerTaskWaiters();
  return 1;
}

function canPumpDueTimer(deadlineMs: number | undefined, maxRunCount: number | undefined): boolean {
  if (timerWheel.size === 0 || !nativeTimerFunctions) return false;
  if (hasReachedPumpLimit(deadlineMs, maxRunCount)) return false;
  return true;
}

function hasReachedPumpLimit(
  deadlineMs: number | undefined,
  maxRunCount: number | undefined,
): boolean {
  if (maxRunCount !== undefined && maxRunCount <= 0) return true;
  return deadlineMs !== undefined && Date.now() >= deadlineMs;
}

function nextDueTimer(currentTimeMs: number): WheelEntry | undefined {
  const timerEntry = nextTimerWheelEntry();
  if (!timerEntry) return undefined;
  if (timerEntry.due > currentTimeMs) {
    armTimerWheelWake();
    return undefined;
  }
  return timerEntry;
}

function clearCurrentTimerWheelWake(): void {
  if (timerWheelWake === null) return;
  try {
    nativeTimerFunctions?.clearTimeout(timerWheelWake);
  } catch {}
  timerWheelWake = null;
  timerWheelWakeDue = Infinity;
}

function runTimerCallback(timerEntry: WheelEntry, deadlineMs: number | undefined): void {
  const previousTimerDeadline = activeTimerDeadline;
  activeTimerDeadline = deadlineMs ?? previousTimerDeadline;
  try {
    timerEntry.callback.call(globalThis, ...timerEntry.callbackArgs);
  } catch (error) {
    try {
      console.error("[kitesurf] pumped timer threw:", error);
    } catch {}
  } finally {
    activeTimerDeadline = previousTimerDeadline;
  }
}

function runPageJobsIfNeeded(): void {
  if (!ks_bridge_ever_minted()) return;
  try {
    ks_run_page_jobs();
  } catch {}
}

function rescheduleRepeatingTimer(timerEntry: WheelEntry): void {
  const wasCancelled = cancelledTimerIds.delete(timerEntry.id);
  if (!timerEntry.repeats || wasCancelled) return;
  timerEntry.due = nativeTimerNow() + timerEntry.delay;
  timerEntry.order = timerWheelNextOrder++;
  timerWheel.set(timerEntry.id, timerEntry);
  pushTimerWheelEntry(timerEntry);
}

function notifyTimerTaskWaiters(): void {
  if (timerTaskWaiters.length === 0) return;
  const pendingWaiters = timerTaskWaiters;
  timerTaskWaiters = [];
  for (const waiter of pendingWaiters) waiter();
}

const portTasks: Array<() => void> = [];
let portTaskWake: unknown = null;

export function queuePortTask(task: () => void): void {
  portTasks.push(task);
  armPortTaskWake();
}

const PORT_WAKE_BUDGET_MS = 50;
const PORT_WAKE_PENDING = {};

function armPortTaskWake(): void {
  if (portTaskWake !== null || portTasks.length === 0) return;
  const st = nativeTimerFunctions ? nativeTimerFunctions.setTimeout : setTimeout;
  portTaskWake = st(() => {
    portTaskWake = PORT_WAKE_PENDING;
    void (async () => {
      const deadline = Date.now() + PORT_WAKE_BUDGET_MS;
      try {
        while (portTasks.length > 0 && pumpPageTask(deadline) > 0) {
          await drainSettleMicrotasks();
        }
      } finally {
        portTaskWake = null;
        armPortTaskWake();
      }
    })();
  }, 0);
}

function runPortTask(): boolean {
  const task = portTasks.shift();
  if (task) runPortCallback(task);
  armPortTaskWake();
  if (task) notifyTimerTaskWaiters();
  return task !== undefined;
}

function runPortCallback(task: () => void): void {
  try {
    task();
  } catch (error) {
    try {
      console.error(error);
    } catch {}
  }
}

// Keep posted messages on a separate FIFO; alternate with due timers to avoid starvation.
let portTaskTurn = false;

export function pumpPageTask(deadlineMs?: number): number {
  if (pageTaskDeadlineReached(deadlineMs)) return 0;
  if (pumpPortTaskFirst()) return 1;
  return pumpTimerThenPort(deadlineMs);
}

function pageTaskDeadlineReached(deadlineMs: number | undefined): boolean {
  return deadlineMs !== undefined && Date.now() >= deadlineMs;
}

function pumpPortTaskFirst(): boolean {
  const portFirst = portTasks.length > 0 && portTaskTurn;
  portTaskTurn = !portTaskTurn;
  return portFirst && runPortTask();
}

function pumpTimerThenPort(deadlineMs: number | undefined): number {
  const timerCallbacksPumped = pumpDueTimers(deadlineMs, 1);
  if (timerCallbacksPumped > 0) return timerCallbacksPumped;
  return runPortTask() ? 1 : 0;
}

export function pageTimerDueWithin(windowMs: number): boolean {
  if (portTasks.length > 0) return true;
  if (!nativeTimerFunctions) return true;
  const nextEntry = nextTimerWheelEntry();
  return nextEntry ? nextEntry.due <= nativeTimerNow() + windowMs : false;
}

export function timersScheduledCount(): number {
  return pageTimerSchedules;
}

export interface TimerWheelStats {
  entries: number;
  armed: boolean;
  wakeOverdueMs: number;
  nextDueInMs: number | null;
  wakesFired: number;
  wakesArmed: number;
}

export function timerWheelStats(): TimerWheelStats {
  const currentTimeMs = nativeTimerNow();
  const nextEntry = nextTimerWheelEntry();
  return {
    entries: timerWheel.size,
    armed: timerWheelWake !== null,
    wakeOverdueMs: timerWheelWake !== null ? Math.round(currentTimeMs - timerWheelWakeDue) : 0,
    nextDueInMs: nextEntry ? Math.round(nextEntry.due - currentTimeMs) : null,
    wakesFired: timerWheelWakesFired,
    wakesArmed: timerWheelWakesArmed,
  };
}

export function installIdleCallbackGlobals(): void {
  if (typeof globalThis.requestIdleCallback !== "function") {
    globalThis.requestIdleCallback = (callback) =>
      (engineSetTimeout ?? setTimeout)(
        () =>
          callback({
            didTimeout: false,
            timeRemaining: () => IDLE_CALLBACK_BUDGET_MS,
          }),
        0,
      );
    globalThis.cancelIdleCallback = (id) => (engineClearTimeout ?? clearTimeout)(id);
  }
}

export function installPageTaskGlobals(
  windowShim: ShimWindow | null,
  defineEnumerableProto: (prototype: object, methods: Record<string, Function>) => void,
): void {
  installTimerWheel();
  try {
    Object.defineProperty(ksGlobal, "__ks_pump_due_timers", {
      value: (deadlineMs?: number) => pumpDueTimers(deadlineMs, 1),
      configurable: false,
      enumerable: false,
      writable: false,
    });
    Object.defineProperty(ksGlobal, "__ks_next_timer_delay", {
      value: () => {
        const nextEntry = nextTimerWheelEntry();
        return nextEntry ? Math.max(0, nextEntry.due - nativeTimerNow()) : Infinity;
      },
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch {}
  const setTimer: NonNullable<typeof engineSetTimeout> = ksGlobal.setTimeout.bind(globalThis);
  const clearTimer: NonNullable<typeof engineClearTimeout> = ksGlobal.clearTimeout.bind(globalThis);
  engineSetTimeout = setTimer;
  engineClearTimeout = clearTimer;
  installIntersectionObserver(windowShim, setTimer, clearTimer, defineEnumerableProto);
  setModelContextTaskScheduler(setTimer);
  setWrapperSweepScheduler(setTimer);
  // Web Animations finish and cancel events are page tasks too, queued behind the
  // page's own timers the way a browser's rendering step would order them.
  setAnimationTaskScheduler(setTimer);
  if (typeof globalThis.requestAnimationFrame !== "function") {
    globalThis.requestAnimationFrame = (callback) => {
      const id = rafNextId++;
      const wasQueueEmpty = rafQueue.size === 0;
      rafQueue.set(id, callback);
      if (wasQueueEmpty) {
        rafNextFrameAt = Date.now() + RAF_FRAME_MS;
        notePaintWake();
      }
      scheduleRafBackstop();
      return id;
    };
    globalThis.cancelAnimationFrame = (id) => {
      rafQueue.delete(id);
    };
  }
}

const PUMP_BUDGET_MS = 50;
// Bound turns as well as wall time so a stalled clock cannot monopolize the isolate.
const MAX_PUMP_TIMER_TURNS = 64;
type PageTaskPumpResult = { pumped: number; pumpMs: number; nextRafDelayMs?: number };
let pageTaskPumpInFlight: Promise<PageTaskPumpResult> | null = null;

export async function pumpDuePageTasks(): Promise<PageTaskPumpResult> {
  if (pageTaskPumpInFlight) return pageTaskPumpInFlight;

  const pumpPromise = runPageTaskPump();
  pageTaskPumpInFlight = pumpPromise;
  try {
    return await pumpPromise;
  } finally {
    pageTaskPumpInFlight = null;
  }
}

async function runPageTaskPump(): Promise<PageTaskPumpResult> {
  const pumpStartedAt = Date.now();
  const deadlineMs = pumpStartedAt + PUMP_BUDGET_MS;
  let tasksPumped = 0;
  let nextRafDelayMs: number | undefined;
  try {
    let timerTurns = 0;
    let pageTasksPumped = pumpPageTask(deadlineMs);
    while (pageTasksPumped > 0) {
      tasksPumped += pageTasksPumped;
      await drainSettleMicrotasks();
      timerTurns++;
      if (shouldStopTimerPump(deadlineMs, timerTurns)) break;
      pageTasksPumped = pumpPageTask(deadlineMs);
    }
    if (Date.now() < deadlineMs) {
      const framesPumped = pumpAnimationFrames(deadlineMs);
      const frameDueAt = rafFrameDueAt();
      tasksPumped += framesPumped;
      await null;
      nextRafDelayMs = nextRafPumpDelay(framesPumped, frameDueAt);
    }
  } catch {
    tasksPumped = -2;
  }
  return { pumped: tasksPumped, pumpMs: Date.now() - pumpStartedAt, nextRafDelayMs };
}

function shouldStopTimerPump(deadlineMs: number, timerTurns: number): boolean {
  return Date.now() >= deadlineMs || timerTurns >= MAX_PUMP_TIMER_TURNS;
}

function nextRafPumpDelay(framesPumped: number, frameDueAt: number): number | undefined {
  if (framesPumped !== 0 || rafQueue.size === 0) return undefined;
  const remainingMs = frameDueAt - Date.now();
  return remainingMs > 0 ? remainingMs : undefined;
}
