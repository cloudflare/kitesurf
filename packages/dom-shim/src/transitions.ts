// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Connects transition and animation listeners to the Rust style-transition sampler.

import { postMutationHooks } from "./registries.js";
import { armTransitionDrain } from "./state.js";

const TRANSITION_EVENT_TYPES = new Set([
  "transitionrun",
  "transitionstart",
  "transitionend",
  "transitioncancel",
]);
const ANIMATION_EVENT_TYPES = new Set([
  "animationstart",
  "animationiteration",
  "animationend",
  "animationcancel",
]);

let transitionListenerCount = 0;
let animationListenerCount = 0;

export function noteListenerType(type: string): void {
  if (TRANSITION_EVENT_TYPES.has(type)) noteTransitionListenerAdded();
  if (ANIMATION_EVENT_TYPES.has(type)) noteAnimationListenerAdded();
}

function noteTransitionListenerAdded(): void {
  transitionListenerCount++;
  if (transitionListenerCount === 1) armTransitionDrain?.();
}

function noteAnimationListenerAdded(): void {
  animationListenerCount++;
  if (animationListenerCount === 1) armTransitionDrain?.(true);
}

export function noteListenerRemoved(type: string): void {
  removeTransitionListener(type);
  removeAnimationListener(type);
}

function removeTransitionListener(type: string): void {
  if (TRANSITION_EVENT_TYPES.has(type) && transitionListenerCount > 0) transitionListenerCount--;
}

function removeAnimationListener(type: string): void {
  if (!ANIMATION_EVENT_TYPES.has(type) || animationListenerCount === 0) return;
  animationListenerCount--;
  if (animationListenerCount === 0) armTransitionDrain?.(false);
}

postMutationHooks.push(() => {
  if (!hasTransitionListeners()) return;
  drainTransitionListeners();
});

function hasTransitionListeners(): boolean {
  return transitionListenerCount !== 0 || animationListenerCount !== 0;
}

function drainTransitionListeners(): void {
  if (animationListenerCount > 0) armTransitionDrain?.(true);
  else armTransitionDrain?.();
}
