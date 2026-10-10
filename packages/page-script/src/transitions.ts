// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Drains transition and animation records from wasm into page-realm events.
// Stylo owns interpolation; `ensure_layout` re-resolves only when animating and the clock moved,
// so nothing wakes an idle page with a live animation until someone reads layout or paints.

import { retryWhenIoAllowed } from "./defer-shim.ts";
import { nativeClearTimeout, nativeSetTimeout } from "./native-scheduling.ts";
import { ksEventCtors, state } from "./state.ts";

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
// When the drain next owes a time-driven sample: a transition's frame or a
// backed-off keyframe sample. Earlier ticks only discover what a mutation
// started, so a page that mutates every frame can't pull the backoff to 60 Hz.
let sampleDueAt = 0;
let tickTimerDelayMs = 0;
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
  tickTimerDelayMs = delayMs;
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
  if (animationListeners !== undefined) {
    animationDrainRequested = animationListeners;
    const dom = state.dom as any;
    try {
      dom?.setAnimationEventsRequested?.(animationListeners);
    } catch {}
    if (!animationListeners) return;
  }
  if (tickPending) {
    armedSinceSchedule = true;
    if (tickTimerDelayMs > TICK_MS) {
      // A backed-off keyframe sample is waiting. Discover the mutation within
      // a frame, but keep the backoff: that tick resolves only a dirty layout.
      deferredTicks = 0;
      scheduleDrain(TICK_MS);
    }
    return;
  }
  armedSinceSchedule = false;
  deferredTicks = 0;
  tickIntervalMs = TICK_MS;
  zeroEventTicks = 0;
  sampleDueAt = 0;
  scheduleDrain(tickIntervalMs);
}

function drainTick(): void {
  tickPending = false;
  const dom = state.dom as any;
  if (
    !dom ||
    (typeof dom.takeTransitionEvents !== "function" &&
      typeof dom.takeAnimationEvents !== "function")
  )
    return;

  const now = Date.now();
  const sampleDue = now >= sampleDueAt;
  if (armedSinceSchedule && deferredTicks < MAX_DEFERRED_TICKS) {
    let pending = false;
    try {
      pending = dom.hasPendingTransitions() === true;
    } catch {}
    if (!pending && sampleDue && animationDrainRequested) {
      try {
        pending = dom.isAnimating() === true;
      } catch {}
    }
    if (!pending) {
      armedSinceSchedule = false;
      deferredTicks++;
      scheduleDrain(TICK_MS);
      return;
    }
  }
  armedSinceSchedule = false;
  if (queuedAnimationEvents.length > 0) {
    dispatchAnimationEvents(queuedAnimationEvents.splice(0, ANIMATION_EVENT_BATCH_SIZE));
    scheduleDrain(0);
    return;
  }
  // A due sample is the frame: the resolve advances the clock and queues the
  // events. Before then only a dirty layout needs a resolve; if another
  // caller already resolved, its events are waiting.
  let transitionEvents: unknown = [];
  let animationEvents: unknown = [];
  let sampled = false;
  try {
    if (sampleDue || dom.layoutClean() !== true) {
      dom.resolveLayout();
      sampled = sampleDue;
    }
    if (typeof dom.takeTransitionEvents === "function") {
      transitionEvents = dom.takeTransitionEvents();
    }
    if (animationDrainRequested && typeof dom.takeAnimationEvents === "function") {
      animationEvents = dom.takeAnimationEvents();
    }
  } catch {
    return;
  }
  if (Array.isArray(transitionEvents) && transitionEvents.length > 0) {
    dispatchTransitionEvents(transitionEvents as TransitionEventData[]);
  }
  if (Array.isArray(animationEvents) && animationEvents.length > 0) {
    queuedAnimationEvents.push(...(animationEvents as AnimationEventData[]));
    dispatchAnimationEvents(queuedAnimationEvents.splice(0, ANIMATION_EVENT_BATCH_SIZE));
  }
  let transitionsPending = false;
  try {
    transitionsPending = dom.hasPendingTransitions() === true;
  } catch {}
  let pending = transitionsPending;
  if (!pending && animationDrainRequested) {
    try {
      pending = dom.isAnimating() === true;
    } catch {}
  }
  if (pending || queuedAnimationEvents.length > 0) {
    // Only a real sample moves the keyframe backoff on.
    if (transitionsPending) {
      zeroEventTicks = 0;
      tickIntervalMs = TICK_MS;
      sampleDueAt = Math.min(sampleDueAt, now + TICK_MS);
    } else if (sampled) {
      zeroEventTicks++;
      tickIntervalMs = Math.min(
        TICK_MS * 2 ** Math.min(zeroEventTicks, MAX_ZERO_EVENT_BACKOFF_EXPONENT),
        MAX_BACKOFF_MS,
      );
    }
    if (sampled) sampleDueAt = now + tickIntervalMs;
    armedSinceSchedule = false;
    deferredTicks = 0;
    scheduleDrain(Math.max(0, sampleDueAt - now));
  }
}

function dispatchTransitionEvents(events: TransitionEventData[]): void {
  const TransitionEventConstructor = ksEventCtors.TransitionEvent;
  const resolveNode = state.resolveNodeId;
  if (!TransitionEventConstructor || typeof resolveNode !== "function") return;
  for (const eventData of events) {
    const element = resolveNode(eventData.nodeId);
    if (!element) continue;
    let event: unknown;
    try {
      event = new TransitionEventConstructor(eventData.type, {
        bubbles: true,
        cancelable: false,
        propertyName: eventData.propertyName,
        elapsedTime: eventData.elapsedTime,
        pseudoElement: "",
      });
    } catch {
      continue;
    }
    try {
      state.dispatchTrustedEvent(element, event);
    } catch {}
  }
}

function dispatchAnimationEvents(events: AnimationEventData[]): void {
  const AnimationEventConstructor = ksEventCtors.AnimationEvent;
  const resolveNode = state.resolveNodeId;
  if (!AnimationEventConstructor || typeof resolveNode !== "function") return;
  for (const eventData of events) {
    const element = resolveNode(eventData.nodeId);
    if (!element) continue;
    let event: unknown;
    try {
      event = new AnimationEventConstructor(eventData.type, {
        bubbles: true,
        cancelable: false,
        animationName: eventData.animationName,
        elapsedTime: eventData.elapsedTime,
        pseudoElement: "",
      });
    } catch {
      continue;
    }
    try {
      state.dispatchTrustedEvent(element, event);
    } catch {}
  }
}
