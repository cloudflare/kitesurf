// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Drains transition and animation records from wasm into page-realm events.
// Stylo owns interpolation; `ensure_layout` re-resolves only when animating and the clock moved,
// so nothing wakes an idle page with a live animation until someone reads layout or paints.

import { retryWhenIoAllowed } from "./defer-shim.ts";
import { nativeClearTimeout, nativeSetTimeout } from "./native-scheduling.ts";
import { ksEventCtors, state } from "./state.ts";
import type { ShimNode } from "./types.ts";

const TICK_MS = 16;

const MAX_BACKOFF_MS = 250;

const ANIMATION_EVENT_BATCH_SIZE = 16;

export function isAnimating(): boolean {
  const dom = state.dom as any;
  if (!dom || typeof dom.isAnimating !== "function") return false;
  try {
    return dom.isAnimating() === true;
  } catch {
    return false;
  }
}

const MAX_DEFERRED_TICKS = 4;
const MAX_ZERO_EVENT_BACKOFF_EXPONENT = 4;

interface TransitionEventData {
  nodeId: number;
  type: string;
  propertyName: string;
  elapsedTime: number;
}

interface AnimationEventData {
  nodeId: number;
  type: string;
  animationName: string;
  elapsedTime: number;
}

let tickPending = false;
let armedSinceSchedule = false;
let deferredTicks = 0;
let animationDrainRequested = false;
let tickIntervalMs = TICK_MS;
let zeroEventTicks = 0;
let tickTimer: ReturnType<typeof setTimeout> | null = null;
let scheduleGen = 0;
const queuedAnimationEvents: AnimationEventData[] = [];

function cancelDrainTimer(): void {
  scheduleGen++;
  if (tickTimer === null) return;
  const timer = tickTimer;
  tickTimer = null;
  try {
    nativeClearTimeout(timer);
  } catch {}
}

function scheduleDrain(delayMs: number): void {
  cancelDrainTimer();
  tickPending = true;
  const gen = scheduleGen;
  try {
    retryWhenIoAllowed(() => {
      if (gen !== scheduleGen) return;
      tickTimer = nativeSetTimeout(() => {
        if (gen !== scheduleGen) return;
        tickTimer = null;
        drainTick();
      }, delayMs);
    });
  } catch {
    tickPending = false;
  }
}

export function armTransitionDrain(animationListeners?: boolean): void {
  if (updateAnimationDrainRequest(animationListeners)) return;
  if (tickPending) {
    armedSinceSchedule = true;
    if (tickIntervalMs > TICK_MS) {
      tickIntervalMs = TICK_MS;
      zeroEventTicks = 0;
      deferredTicks = 0;
      scheduleDrain(TICK_MS);
    }
    return;
  }
  armedSinceSchedule = false;
  deferredTicks = 0;
  tickIntervalMs = TICK_MS;
  zeroEventTicks = 0;
  scheduleDrain(tickIntervalMs);
}

function updateAnimationDrainRequest(animationListeners: boolean | undefined): boolean {
  if (animationListeners === undefined) return false;
  animationDrainRequested = animationListeners;
  try {
    const dom = state.dom as any;
    dom?.setAnimationEventsRequested?.(animationListeners);
  } catch {}
  return !animationListeners;
}

function hasEventSource(dom: any): boolean {
  return (
    typeof dom.takeTransitionEvents === "function" || typeof dom.takeAnimationEvents === "function"
  );
}

function canDrainEvents(dom: any): boolean {
  return !!dom && hasEventSource(dom);
}

function hasTransitionWork(dom: any): boolean {
  try {
    return dom.hasPendingTransitions() === true;
  } catch {
    return false;
  }
}

function hasAnimationWork(dom: any): boolean {
  try {
    return dom.isAnimating() === true;
  } catch {
    return false;
  }
}

function hasArmedWork(dom: any): boolean {
  return hasTransitionWork(dom) || (animationDrainRequested && hasAnimationWork(dom));
}

function deferArmedDrain(dom: any): boolean {
  if (!armedSinceSchedule || deferredTicks >= MAX_DEFERRED_TICKS) return false;
  if (hasArmedWork(dom)) return false;
  armedSinceSchedule = false;
  deferredTicks++;
  scheduleDrain(tickIntervalMs);
  return true;
}

function drainQueuedAnimationEvents(): boolean {
  if (queuedAnimationEvents.length === 0) return false;
  dispatchAnimationEvents(queuedAnimationEvents.splice(0, ANIMATION_EVENT_BATCH_SIZE));
  scheduleDrain(0);
  return true;
}

interface PendingEvents {
  transitions: unknown;
  animations: unknown;
}

function takePendingEvents(dom: any): PendingEvents | null {
  let transitions: unknown = [];
  let animations: unknown = [];
  try {
    if (typeof dom.takeTransitionEvents === "function") {
      transitions = dom.takeTransitionEvents();
    }
    if (animationDrainRequested && typeof dom.takeAnimationEvents === "function") {
      animations = dom.takeAnimationEvents();
    }
  } catch {
    return null;
  }
  return { transitions, animations };
}

function dispatchTransitionsIfAny(events: unknown): void {
  if (Array.isArray(events) && events.length > 0) {
    dispatchTransitionEvents(events as TransitionEventData[]);
  }
}

function queueAnimationsIfAny(events: unknown): void {
  if (!Array.isArray(events) || events.length === 0) return;
  queuedAnimationEvents.push(...(events as AnimationEventData[]));
  dispatchAnimationEvents(queuedAnimationEvents.splice(0, ANIMATION_EVENT_BATCH_SIZE));
}

function dispatchPendingEvents(events: PendingEvents): void {
  dispatchTransitionsIfAny(events.transitions);
  queueAnimationsIfAny(events.animations);
}

function isAnimationDrainPending(dom: any, transitionsPending: boolean): boolean {
  if (transitionsPending || !animationDrainRequested) return false;
  return hasAnimationWork(dom);
}

function schedulePendingDrain(dom: any): void {
  const transitionsPending = hasTransitionWork(dom);
  const animationPending = isAnimationDrainPending(dom, transitionsPending);
  if (!transitionsPending && !animationPending && queuedAnimationEvents.length === 0) return;
  if (transitionsPending) {
    zeroEventTicks = 0;
    tickIntervalMs = TICK_MS;
  } else {
    zeroEventTicks++;
    tickIntervalMs = Math.min(
      TICK_MS * 2 ** Math.min(zeroEventTicks, MAX_ZERO_EVENT_BACKOFF_EXPONENT),
      MAX_BACKOFF_MS,
    );
  }
  armedSinceSchedule = false;
  deferredTicks = 0;
  scheduleDrain(tickIntervalMs);
}

function drainTick(): void {
  tickPending = false;
  const dom = state.dom as any;
  if (!canDrainEvents(dom)) return;

  if (deferArmedDrain(dom)) return;
  armedSinceSchedule = false;
  if (drainQueuedAnimationEvents()) return;
  const events = takePendingEvents(dom);
  if (!events) return;
  dispatchPendingEvents(events);
  schedulePendingDrain(dom);
}

function dispatchTrustedPageEvent(
  constructor: any,
  element: ShimNode,
  type: string,
  init: Record<string, unknown>,
): void {
  let event: unknown;
  try {
    event = new constructor(type, init);
  } catch {
    return;
  }
  try {
    state.dispatchTrustedEvent(element, event);
  } catch {}
}

function dispatchTransitionEvents(events: TransitionEventData[]): void {
  const constructor = ksEventCtors.TransitionEvent;
  const resolveNode = state.resolveNodeId;
  if (!constructor || typeof resolveNode !== "function") return;
  for (const eventData of events) {
    const element = resolveNode(eventData.nodeId);
    if (!element) continue;
    dispatchTrustedPageEvent(constructor, element, eventData.type, {
      bubbles: true,
      cancelable: false,
      propertyName: eventData.propertyName,
      elapsedTime: eventData.elapsedTime,
      pseudoElement: "",
    });
  }
}

function dispatchAnimationEvents(events: AnimationEventData[]): void {
  const constructor = ksEventCtors.AnimationEvent;
  const resolveNode = state.resolveNodeId;
  if (!constructor || typeof resolveNode !== "function") return;
  for (const eventData of events) {
    const element = resolveNode(eventData.nodeId);
    if (!element) continue;
    dispatchTrustedPageEvent(constructor, element, eventData.type, {
      bubbles: true,
      cancelable: false,
      animationName: eventData.animationName,
      elapsedTime: eventData.elapsedTime,
      pseudoElement: "",
    });
  }
}
