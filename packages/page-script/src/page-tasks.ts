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
import { ksInternals } from "./internals.ts";
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
  if (rafTimer !== null) {
    if (Date.now() - rafArmedAt <= delay + RAF_BACKSTOP_STALE_MS) return;
    try {
      (engineClearTimeout ?? clearTimeout)(rafTimer);
    } catch {}
    rafTimer = null;
  }
  rafArmedAt = Date.now();
  rafTimer = (engineSetTimeout ?? setTimeout)(() => {
    rafTimer = null;
    pumpAnimationFrames(activeTimerDeadline);
  }, delay);
}

export function hasPendingAnimationFrames(): boolean {
  return rafQueue.size > 0;
}

function rafFrameDueAt(): number {
  return rafDriverTurn ? rafBatchDueAt : rafNextFrameAt;
}

export function pumpAnimationFrames(deadlineMs?: number): number {
  if (rafQueue.size === 0) return 0;
  if ((rafDriven() && !rafDriverTurn) || Date.now() < rafFrameDueAt()) {
    scheduleRafBackstop();
    return 0;
  }

  rafDriverTurn = false;
  // Snapshot handles so callbacks queued during this batch wait for a later batch.
  // Each handle is removed before its callback runs, matching HTML's cancellation/requeue order.
  // https://html.spec.whatwg.org/#run-the-animation-frame-callbacks
  const frameCallbackIds = [...rafQueue.keys()];
  if (rafTimer !== null) {
    try {
      (engineClearTimeout ?? clearTimeout)(rafTimer);
    } catch {}
    rafTimer = null;
  }
  const pumpStartedAt = Date.now();
  const deadline = deadlineMs ?? pumpStartedAt + RAF_PUMP_BUDGET_MS;
  const frameTimestamp = performance.now();
  let callbacksRun = 0;
  let stoppedByDeadline = false;
  for (let index = 0; index < frameCallbackIds.length; index++) {
    if (Date.now() >= deadline) {
      stoppedByDeadline = true;
      break;
    }
    const id = frameCallbackIds[index]!;
    const callback = rafQueue.get(id);
    if (callback === undefined) continue;
    rafQueue.delete(id);
    try {
      callback(frameTimestamp);
      callbacksRun++;
    } catch (error) {
      try {
        console.error("[kitesurf] rAF callback threw:", error);
      } catch {}
    }
  }
  if (!stoppedByDeadline) {
    const nextFromStart = pumpStartedAt + RAF_FRAME_MS - RAF_FRAME_SLACK_MS;
    const frameEndedAt = Date.now();
    rafBatchDueAt = frameEndedAt < nextFromStart ? nextFromStart : frameEndedAt + RAF_FRAME_MS;
    if (rafQueue.size > 0) rafNextFrameAt = rafBatchDueAt;
  }
  recheckIntersectionObservers("frame");
  lastPumpMs = Date.now() - pumpStartedAt;
  scheduleRafBackstop();
  return callbacksRun;
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
  let index = 0;
  while (true) {
    const left = index * 2 + 1;
    if (left >= timerWheelHeap.length) break;
    const right = left + 1;
    const leftEntry = timerWheelHeap[left];
    if (!leftEntry) break;
    const rightEntry = timerWheelHeap[right];
    const child =
      right < timerWheelHeap.length && rightEntry && timerPrecedes(rightEntry, leftEntry)
        ? right
        : left;
    const childEntry = timerWheelHeap[child];
    if (!last || !childEntry || !timerPrecedes(childEntry, last)) break;
    timerWheelHeap[index] = childEntry;
    index = child;
  }
  if (last) timerWheelHeap[index] = last;
  return first;
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
    if (timerWheelWake !== null) {
      try {
        capturedTimers.clearTimeout(timerWheelWake);
      } catch {}
    }
    timerWheelWake = null;
    timerWheelWakeDue = Infinity;
    return;
  }
  const currentTimeMs = nativeTimerNow();
  const delay = Math.min(MAX_NATIVE_TIMER_DELAY, Math.max(0, nextEntry.due - currentTimeMs));
  const wakeDue = currentTimeMs + delay;
  if (timerWheelWake !== null && timerWheelWakeDue <= wakeDue) return;
  const previousWake = timerWheelWake;
  const previousWakeDue = timerWheelWakeDue;
  const scheduleWake = (wakeDelay: number): number => {
    let scheduledWakeId = 0;
    timerWheelWakesArmed++;
    scheduledWakeId = capturedTimers.setTimeout(() => {
      timerWheelWakesFired++;
      if (timerWheelWake !== scheduledWakeId) return;
      const wakeDueMs = timerWheelWakeDue;
      timerWheelWake = null;
      timerWheelWakeDue = Infinity;
      pumpDueTimers(undefined, undefined, wakeDueMs);
    }, wakeDelay);
    return scheduledWakeId;
  };
  let previousWakeCleared = false;
  let nextWake: number;
  try {
    nextWake = scheduleWake(delay);
  } catch (error) {
    if (
      previousWake === null ||
      !/too many active timeouts/i.test(error instanceof Error ? error.message : String(error))
    ) {
      throw error;
    }
    capturedTimers.clearTimeout(previousWake);
    previousWakeCleared = true;
    timerWheelWake = null;
    timerWheelWakeDue = Infinity;
    try {
      nextWake = scheduleWake(delay);
    } catch (retryError) {
      try {
        const restoreDelay = Math.min(
          MAX_NATIVE_TIMER_DELAY,
          Math.max(0, previousWakeDue - nativeTimerNow()),
        );
        timerWheelWake = scheduleWake(restoreDelay);
        timerWheelWakeDue = nativeTimerNow() + restoreDelay;
      } catch {}
      throw retryError;
    }
  }
  timerWheelWake = nextWake;
  timerWheelWakeDue = wakeDue;
  if (previousWake !== null && !previousWakeCleared) {
    try {
      capturedTimers.clearTimeout(previousWake);
    } catch {}
  }
}

function toTimerLong(value: unknown): number {
  if (value === undefined) return 0;
  const number = +(value as number);
  if (!Number.isFinite(number) || number === 0) return 0;
  const modulo = Math.trunc(number) % TIMER_ID_MODULO;
  const signed =
    modulo >= TIMER_ID_SIGNED_BOUNDARY
      ? modulo - TIMER_ID_MODULO
      : modulo < -TIMER_ID_SIGNED_BOUNDARY
        ? modulo + TIMER_ID_MODULO
        : modulo;
  return signed;
}

function scheduleWheelTimer(
  callback: (...callbackArgs: unknown[]) => void,
  delayValue: unknown,
  callbackArgs: unknown[],
  repeats: boolean,
): number {
  const delay = Math.max(0, toTimerLong(delayValue));
  while (timerWheel.has(timerWheelNextId) || runningTimerIds.has(timerWheelNextId)) {
    timerWheelNextId =
      timerWheelNextId === MAX_PAGE_TIMER_ID ? FIRST_PAGE_TIMER_ID : timerWheelNextId + 1;
  }
  const id = timerWheelNextId;
  timerWheelNextId = id === MAX_PAGE_TIMER_ID ? FIRST_PAGE_TIMER_ID : id + 1;
  const due = nativeTimerNow() + delay;
  const timerEntry = {
    id,
    order: timerWheelNextOrder++,
    callback,
    callbackArgs,
    due,
    delay,
    repeats,
  };
  timerWheel.set(id, timerEntry);
  pushTimerWheelEntry(timerEntry);
  try {
    armTimerWheelWake();
  } catch (error) {
    timerWheel.delete(id);
    try {
      armTimerWheelWake();
    } catch {}
    throw error;
  }
  return id;
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
  if (timerWheel.size === 0 || !nativeTimerFunctions) return 0;
  if (maxRunCount !== undefined && maxRunCount <= 0) return 0;
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) return 0;
  const currentTimeMs = Math.max(nativeTimerNow(), wakeDueMs);
  const timerEntry = nextTimerWheelEntry();
  if (!timerEntry) return 0;
  if (timerEntry.due > currentTimeMs) {
    armTimerWheelWake();
    return 0;
  }
  if (timerWheelWake !== null) {
    try {
      nativeTimerFunctions.clearTimeout(timerWheelWake);
    } catch {}
    timerWheelWake = null;
    timerWheelWakeDue = Infinity;
  }
  popTimerWheelEntry();
  timerWheel.delete(timerEntry.id);
  runningTimerIds.add(timerEntry.id);
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
  if (ks_bridge_ever_minted()) {
    try {
      ks_run_page_jobs();
    } catch {}
  }
  runningTimerIds.delete(timerEntry.id);
  const wasCancelled = cancelledTimerIds.delete(timerEntry.id);
  if (timerEntry.repeats && !wasCancelled) {
    timerEntry.due = nativeTimerNow() + timerEntry.delay;
    timerEntry.order = timerWheelNextOrder++;
    timerWheel.set(timerEntry.id, timerEntry);
    pushTimerWheelEntry(timerEntry);
  }
  armTimerWheelWake();
  if (timerTaskWaiters.length > 0) {
    const pendingWaiters = timerTaskWaiters;
    timerTaskWaiters = [];
    for (const waiter of pendingWaiters) waiter();
  }
  return 1;
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
  if (task) {
    try {
      task();
    } catch (error) {
      try {
        console.error(error);
      } catch {}
    }
  }
  armPortTaskWake();
  if (task && timerTaskWaiters.length > 0) {
    const pendingWaiters = timerTaskWaiters;
    timerTaskWaiters = [];
    for (const waiter of pendingWaiters) waiter();
  }
  return task !== undefined;
}

// Keep posted messages on a separate FIFO; alternate with due timers to avoid starvation.
let portTaskTurn = false;

export function pumpPageTask(deadlineMs?: number): number {
  if (deadlineMs !== undefined && Date.now() >= deadlineMs) return 0;
  const portFirst = portTasks.length > 0 && portTaskTurn;
  portTaskTurn = !portTaskTurn;
  if (portFirst && runPortTask()) return 1;
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
  // The wasm drains due timers through these while boa awaits a promise.
  // Read-only, so page JS reaching the record can't swap the timer pump.
  if (!ksInternals.pumpDueTimers) {
    Object.defineProperty(ksInternals, "pumpDueTimers", {
      value: (deadlineMs?: number) => pumpDueTimers(deadlineMs, 1),
    });
    Object.defineProperty(ksInternals, "nextTimerDelay", {
      value: () => {
        const nextEntry = nextTimerWheelEntry();
        return nextEntry ? Math.max(0, nextEntry.due - nativeTimerNow()) : Infinity;
      },
    });
  }
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

  const pumpPromise = (async () => {
    const pumpStartedAt = Date.now();
    const deadlineMs = pumpStartedAt + PUMP_BUDGET_MS;
    let tasksPumped = 0;
    let nextRafDelayMs: number | undefined;
    try {
      let timerTurns = 0;
      for (;;) {
        const pageTasksPumped = pumpPageTask(deadlineMs);
        if (pageTasksPumped === 0) break;
        tasksPumped += pageTasksPumped;
        await drainSettleMicrotasks();
        if (Date.now() >= deadlineMs || ++timerTurns >= MAX_PUMP_TIMER_TURNS) break;
      }
      if (Date.now() < deadlineMs) {
        const framesPumped = pumpAnimationFrames(deadlineMs);
        const frameDueAt = rafFrameDueAt();
        tasksPumped += framesPumped;
        await null;
        if (framesPumped === 0 && rafQueue.size > 0) {
          const remainingMs = frameDueAt - Date.now();
          if (remainingMs > 0) nextRafDelayMs = remainingMs;
        }
      }
    } catch {
      tasksPumped = -2;
    }
    return { pumped: tasksPumped, pumpMs: Date.now() - pumpStartedAt, nextRafDelayMs };
  })();
  pageTaskPumpInFlight = pumpPromise;
  try {
    return await pumpPromise;
  } finally {
    pageTaskPumpInFlight = null;
  }
}
