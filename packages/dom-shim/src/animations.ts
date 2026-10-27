// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Web Animations (web-animations-1): Element.animate, Animation, KeyframeEffect, timelines.
// Timing math and interpolation live in Rust (core waapi.rs); this owns the playback model.

import type * as Idl from "./idl/types.generated.js";
import { KsEvent, setEventCurrentTarget, setEventTarget } from "./events/event.js";
import { bumpMutationSeq } from "./mutations/seq.js";
import { dom, ksGlobal } from "./state.js";

type TaskScheduler = (fn: () => void, ms: number) => unknown;
type Direction = "normal" | "reverse" | "alternate" | "alternate-reverse";
type Fill = "none" | "forwards" | "backwards" | "both" | "auto";
type Composite = "replace" | "add" | "accumulate" | "auto";

const DIRECTIONS: readonly Direction[] = ["normal", "reverse", "alternate", "alternate-reverse"];
const FILLS: readonly Fill[] = ["none", "forwards", "backwards", "both", "auto"];
const COMPOSITES: readonly Composite[] = ["replace", "add", "accumulate", "auto"];
const RESERVED_KEYFRAME_KEYS = new Set(["offset", "easing", "composite"]);
const ILLEGAL = Symbol("ks-animation-internal");

// Page-script hands over the timer wheel's setTimeout so finish/cancel events share the
// page's task FIFO; the raw timer only covers animations started before that handover.
let scheduleTask: TaskScheduler = (fn, ms) => setTimeout(fn, ms);
export function setAnimationTaskScheduler(scheduler: TaskScheduler): void {
  scheduleTask = scheduler;
}

// Rust samples the same clock (now_for_animations), so the epoch start time JS hands
// over and the time Rust measures from it agree. In production Date.now freezes within a
// turn, so deltas around synchronous work read 0.
function clockMs(): number {
  const floor = Number(Reflect.get(globalThis, "__ks_clock_floor_ms"));
  return Number.isFinite(floor) ? Math.max(Date.now(), floor) : Date.now();
}

function domException(message: string, name: string): Error {
  return new ksGlobal.DOMException(message, name);
}

interface TimingState {
  delay: number;
  endDelay: number;
  fill: Fill;
  iterationStart: number;
  iterations: number;
  duration: number | "auto";
  direction: Direction;
  easing: string;
}

function defaultTiming(): TimingState {
  return {
    delay: 0,
    endDelay: 0,
    fill: "auto",
    iterationStart: 0,
    iterations: 1,
    duration: "auto",
    direction: "normal",
    easing: "linear",
  };
}

function timingArray(t: TimingState): number[] {
  const fill = t.fill === "auto" ? 0 : FILLS.indexOf(t.fill);
  const duration = t.duration === "auto" ? 0 : t.duration;
  return [
    t.delay,
    t.endDelay,
    duration,
    t.iterations,
    t.iterationStart,
    DIRECTIONS.indexOf(t.direction),
    fill,
  ];
}

// The Rust parser is the easing grammar of record: anything stylo can't compute as an
// <easing-function> would sample as linear, so it has to be the TypeError Chrome throws.
function checkEasing(easing: string): void {
  try {
    dom.waapiComputedTiming(new Float64Array(timingArray(defaultTiming())), easing, undefined, 1);
  } catch (e) {
    throw new TypeError(
      e instanceof Error ? e.message : `'${easing}' is not a valid value for easing`,
    );
  }
}

function finiteDouble(value: unknown, member: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new TypeError(
      `Failed to read the '${member}' property from 'EffectTiming': The provided double value is non-finite.`,
    );
  }
  return n;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], type: string): T {
  const s = String(value);
  const member = allowed.find((a) => a === s);
  if (member === undefined) {
    throw new TypeError(`The provided value '${s}' is not a valid enum value of type ${type}.`);
  }
  return member;
}

type TimingReader = (member: string) => unknown;

function isTimingDictionary(input: unknown): input is object {
  return typeof input === "object" || typeof input === "function";
}

function applyDelay(state: TimingState, read: TimingReader): void {
  const value = read("delay");
  if (value !== undefined) state.delay = finiteDouble(value, "delay");
}

function applyDirection(state: TimingState, read: TimingReader): void {
  const value = read("direction");
  if (value !== undefined) state.direction = enumValue(value, DIRECTIONS, "PlaybackDirection");
}

function durationValue(duration: unknown): number | "auto" {
  if (typeof duration === "string") {
    if (duration === "auto") return "auto";
    throw new TypeError(`Invalid duration '${duration}'.`);
  }
  const n = Number(duration);
  if (Number.isNaN(n) || n < 0) {
    throw new TypeError("Effect duration must be a non-negative number or 'auto'.");
  }
  return n;
}

function applyDuration(state: TimingState, read: TimingReader): void {
  const duration = read("duration");
  if (duration !== undefined) state.duration = durationValue(duration);
}

function applyEasing(state: TimingState, read: TimingReader): void {
  const easing = read("easing");
  if (easing !== undefined) state.easing = String(easing);
}

function applyEndDelay(state: TimingState, read: TimingReader): void {
  const value = read("endDelay");
  if (value !== undefined) state.endDelay = finiteDouble(value, "endDelay");
}

function applyFill(state: TimingState, read: TimingReader): void {
  const value = read("fill");
  if (value !== undefined) state.fill = enumValue(value, FILLS, "FillMode");
}

function applyIterationStart(state: TimingState, read: TimingReader): void {
  const value = read("iterationStart");
  if (value === undefined) return;
  const n = finiteDouble(value, "iterationStart");
  if (n < 0) throw new TypeError("iterationStart must be non-negative.");
  state.iterationStart = n;
}

function applyIterations(state: TimingState, read: TimingReader): void {
  const value = read("iterations");
  if (value === undefined) return;
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) throw new TypeError("iterations must be non-negative.");
  state.iterations = n;
}

// Members are read in IDL dictionary order (alphabetical), then validated together so a
// bad member leaves the timing untouched, as updateTiming() requires.
function applyTiming(state: TimingState, input: unknown): void {
  if (input === undefined || input === null) return;
  if (!isTimingDictionary(input)) {
    throw new TypeError("Failed to convert value to 'OptionalEffectTiming'.");
  }
  const read = (member: string): unknown => Reflect.get(input, member);
  const next = { ...state };
  applyDelay(next, read);
  applyDirection(next, read);
  applyDuration(next, read);
  applyEasing(next, read);
  applyEndDelay(next, read);
  applyFill(next, read);
  applyIterationStart(next, read);
  applyIterations(next, read);
  if (next.easing !== state.easing) checkEasing(next.easing);
  Object.assign(state, next);
}

interface Keyframe {
  offset: number | null;
  computedOffset: number;
  easing: string;
  composite: Composite;
  props: Map<string, string>;
}

// IDL attribute names only: `backgroundColor`, `cssFloat`, `--custom`. Chrome ignores the
// hyphenated CSS spelling as a keyframe key, so `background-color` maps to nothing.
const CSS_PROPERTY_ALIASES = new Map([
  ["cssFloat", "float"],
  ["cssOffset", "offset"],
]);

function isUnsupportedCssPropertyName(key: string): boolean {
  return key.includes("-") || key === "float";
}

function kebabCaseCssProperty(key: string): string {
  const css = key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  return css.startsWith("webkit-") ? "-" + css : css;
}

function cssPropertyName(key: string): string | null {
  if (key.startsWith("--")) return key;
  const alias = CSS_PROPERTY_ALIASES.get(key);
  if (alias !== undefined) return alias;
  if (isUnsupportedCssPropertyName(key)) return null;
  return kebabCaseCssProperty(key);
}

function keyframeOffset(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TypeError("Keyframe offsets must be finite numbers.");
  return n;
}

function isIterable(value: unknown): value is Iterable<unknown> {
  const holder = (typeof value === "object" && value !== null) || typeof value === "function";
  return holder && typeof Reflect.get(value, Symbol.iterator) === "function";
}

function toList(value: unknown): unknown[] {
  return typeof value === "object" && isIterable(value) ? Array.from(value) : [value];
}

function validateOffset(offset: number | null, floor: number): number {
  if (offset === null) return floor;
  if (offset < 0 || offset > 1) {
    throw new TypeError("Offsets must be null or in the range [0,1].");
  }
  if (offset < floor) throw new TypeError("Offsets must be monotonically non-decreasing.");
  return offset;
}

function validateOffsets(frames: Keyframe[]): void {
  let floor = -Infinity;
  for (const frame of frames) floor = validateOffset(frame.offset, floor);
}

function computeMissingOffsets(frames: Keyframe[]): void {
  if (frames.length === 0) return;
  for (const f of frames) f.computedOffset = f.offset ?? NaN;
  if (frames.length > 1 && Number.isNaN(frames[0].computedOffset)) frames[0].computedOffset = 0;
  const last = frames[frames.length - 1];
  if (Number.isNaN(last.computedOffset)) last.computedOffset = 1;
  let prev = 0;
  for (let i = 1; i < frames.length; i++) {
    if (Number.isNaN(frames[i].computedOffset)) continue;
    const span = i - prev;
    for (let j = prev + 1; j < i; j++) {
      const a = frames[prev].computedOffset;
      frames[j].computedOffset = a + ((frames[i].computedOffset - a) * (j - prev)) / span;
    }
    prev = i;
  }
}

function checkFrameEasings(frames: Keyframe[]): void {
  for (const frame of frames) checkEasing(frame.easing);
}

function finalizeKeyframes(frames: Keyframe[], computeOffsets: boolean): Keyframe[] {
  validateOffsets(frames);
  if (computeOffsets) computeMissingOffsets(frames);
  checkFrameEasings(frames);
  return frames;
}

function isKeyframeProperty(key: string): boolean {
  return !RESERVED_KEYFRAME_KEYS.has(key) && !!cssPropertyName(key);
}

function keyframeObject(entry: unknown): object {
  let keyframe: object;
  if (entry === undefined || entry === null) keyframe = {};
  else if (typeof entry === "object") keyframe = entry;
  else throw new TypeError("Keyframes must be objects.");
  return keyframe;
}

function keyframeProperties(keyframe: object): Map<string, string> {
  const props = new Map<string, string>();
  for (const key of Object.keys(keyframe)) {
    if (isKeyframeProperty(key)) props.set(key, String(Reflect.get(keyframe, key)));
  }
  return props;
}

function keyframeComposite(composite: unknown): Composite {
  if (composite === undefined || composite === null) return "auto";
  return enumValue(composite, COMPOSITES, "CompositeOperationOrAuto");
}

function keyframeFromEntry(entry: unknown): Keyframe {
  const keyframe = keyframeObject(entry);
  const props = keyframeProperties(keyframe);
  const easing: unknown = Reflect.get(keyframe, "easing");
  const composite: unknown = Reflect.get(keyframe, "composite");
  return {
    offset: keyframeOffset(Reflect.get(keyframe, "offset")),
    computedOffset: NaN,
    easing: easing === undefined ? "linear" : String(easing),
    composite: keyframeComposite(composite),
    props,
  };
}

function processIterableKeyframes(input: unknown): Keyframe[] {
  if (!isIterable(input)) throw new TypeError("Keyframes argument is not iterable.");
  const entries = Array.from(input);
  const frames: Keyframe[] = [];
  for (const entry of entries) frames.push(keyframeFromEntry(entry));
  return finalizeKeyframes(frames, true);
}

function addPropertyKeyframes(
  byOffset: Map<number, Map<string, string>>,
  key: string,
  input: object,
): void {
  if (!isKeyframeProperty(key)) return;
  const values = toList(Reflect.get(input, key)).map(String);
  values.forEach((value, i) => {
    const at = values.length === 1 ? 1 : i / (values.length - 1);
    let props = byOffset.get(at);
    if (!props) byOffset.set(at, (props = new Map()));
    props.set(key, value);
  });
}

function propertyKeyframesByOffset(input: object): Map<number, Map<string, string>> {
  const byOffset = new Map<number, Map<string, string>>();
  for (const key of Object.keys(input).sort()) addPropertyKeyframes(byOffset, key, input);
  return byOffset;
}

function keyframesFromOffsets(byOffset: Map<number, Map<string, string>>): Keyframe[] {
  const frames: Keyframe[] = [];
  const entries = [...byOffset.entries()].sort((a, b) => a[0] - b[0]);
  for (const [offset, props] of entries) {
    frames.push({
      offset: null,
      computedOffset: offset,
      easing: "linear",
      composite: "auto",
      props,
    });
  }
  return frames;
}

function frameValues(input: object, name: string): unknown[] {
  const value: unknown = Reflect.get(input, name);
  return value === undefined ? [] : toList(value);
}

function applyPropertyOffsets(frames: Keyframe[], input: object): unknown[] {
  const offsets = frameValues(input, "offset");
  offsets.slice(0, frames.length).forEach((offset, index) => {
    frames[index].offset = keyframeOffset(offset);
  });
  return offsets;
}

function applyPropertyEasings(frames: Keyframe[], input: object): void {
  const easings = frameValues(input, "easing").map(String);
  if (easings.length === 0) return;
  frames.forEach((frame, index) => {
    frame.easing = easings[index % easings.length];
  });
}

function applyPropertyComposites(frames: Keyframe[], input: object): void {
  const composites = frameValues(input, "composite");
  if (composites.length === 0) return;
  frames.forEach((frame, index) => {
    frame.composite = enumValue(
      composites[index % composites.length],
      COMPOSITES,
      "CompositeOperationOrAuto",
    );
  });
}

function finalizePropertyKeyframes(frames: Keyframe[], offsets: unknown[]): Keyframe[] {
  if (offsets.length === 0) {
    for (const frame of frames) frame.offset = null;
    return finalizeKeyframes(frames, false);
  }
  return finalizeKeyframes(frames, true);
}

function processPropertyKeyframes(input: object): Keyframe[] {
  const frames = keyframesFromOffsets(propertyKeyframesByOffset(input));
  const offsets = applyPropertyOffsets(frames, input);
  applyPropertyEasings(frames, input);
  applyPropertyComposites(frames, input);
  return finalizePropertyKeyframes(frames, offsets);
}

function isMissingKeyframeInput(input: unknown): boolean {
  return input === undefined || input === null;
}

function processKeyframeDictionary(input: object): Keyframe[] {
  const iterator = Reflect.get(input, Symbol.iterator);
  if (iterator !== undefined && iterator !== null) return processIterableKeyframes(input);
  return processPropertyKeyframes(input);
}

function processKeyframes(input: unknown): Keyframe[] {
  if (isMissingKeyframeInput(input)) return [];
  if (!isTimingDictionary(input)) throw new TypeError("Keyframes argument must be an object.");
  return processKeyframeDictionary(input);
}

function keyframesJson(frames: Keyframe[]): string {
  return JSON.stringify(
    frames.map((f) => ({
      offset: f.computedOffset,
      easing: f.easing === "linear" ? null : f.easing,
      props: [...f.props].flatMap(([key, value]) => {
        const css = cssPropertyName(key);
        return css ? [[css, value]] : [];
      }),
    })),
  );
}

function nodeIdOf(target: unknown): number {
  const id: unknown =
    typeof target === "object" && target !== null ? Reflect.get(target, "_id") : undefined;
  return typeof id === "number" && id > 0 ? id : 0;
}

function isEventHandler(value: unknown): value is Idl.EventHandlerNonNull {
  return typeof value === "function";
}

export class KsAnimationTimeline {
  constructor(token?: unknown) {
    if (token !== ILLEGAL) throw new TypeError("Illegal constructor");
  }
  get currentTime(): number | null {
    return null;
  }
  // Epoch ms the timeline's zero sits at. Start times cross to Rust as epoch ms, because
  // Rust measures them against the animation clock, not against this timeline.
  get _originEpoch(): number {
    return 0;
  }
}

export class KsDocumentTimeline extends KsAnimationTimeline implements Idl.DocumentTimeline {
  #origin: number;
  constructor(options?: { originTime?: number }) {
    super(ILLEGAL);
    const originTime =
      options?.originTime === undefined ? 0 : finiteDouble(options.originTime, "originTime");
    this.#origin = documentTimelineOrigin + originTime;
  }
  override get currentTime(): number | null {
    return clockMs() - this.#origin;
  }
  override get _originEpoch(): number {
    return this.#origin;
  }
}

const documentTimelineOrigin = clockMs();
let documentTimeline: KsDocumentTimeline | null = null;
export function getDocumentTimeline(): KsDocumentTimeline {
  return (documentTimeline ??= new KsDocumentTimeline());
}

export class KsAnimationEffect implements Idl.AnimationEffect {
  _timing: TimingState = defaultTiming();
  _animation: KsAnimation | null = null;
  constructor(token?: unknown) {
    if (token !== ILLEGAL) throw new TypeError("Illegal constructor");
  }
  getTiming(): Idl.EffectTiming & Record<string, unknown> {
    const t = this._timing;
    return {
      delay: t.delay,
      endDelay: t.endDelay,
      fill: t.fill,
      iterationStart: t.iterationStart,
      iterations: t.iterations,
      duration: t.duration,
      direction: t.direction,
      easing: t.easing,
    };
  }
  getComputedTiming(): Idl.ComputedEffectTiming & Record<string, unknown> {
    const t = this._timing;
    const anim = this._animation;
    const localTime = computedEffectLocalTime(anim);
    const out = dom.waapiComputedTiming(
      new Float64Array(timingArray(t)),
      t.easing,
      localTime ?? undefined,
      computedEffectPlaybackRate(anim),
    );
    return {
      ...this.getTiming(),
      fill: computedTimingFill(t.fill),
      duration: computedTimingDuration(t.duration),
      activeDuration: out[1],
      endTime: out[2],
      localTime,
      progress: nullableTimingValue(out[3]),
      currentIteration: nullableTimingValue(out[4]),
    };
  }
  updateTiming(timing?: Idl.OptionalEffectTiming): void {
    applyTiming(this._timing, timing);
    this._changed();
  }
  _endTime(): number {
    const t = this._timing;
    const duration = t.duration === "auto" ? 0 : t.duration;
    const active = duration === 0 || t.iterations === 0 ? 0 : duration * t.iterations;
    return Math.max(t.delay + active + t.endDelay, 0);
  }
  _changed(): void {
    this._animation?._effectChanged();
  }
}

// A shim node carries a node id and nodeIdOf reads 0 for anything else, which is
// the check an effect's target must pass.
function isTargetElement(value: unknown): value is Idl.Element {
  return typeof value === "object" && value !== null && nodeIdOf(value) !== 0;
}

function isStyleDeclaration(value: unknown): value is Idl.CSSStyleDeclaration {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "setProperty") === "function"
  );
}

function computedEffectLocalTime(animation: KsAnimation | null): number | null {
  return animation ? animation.currentTime : null;
}

function computedEffectPlaybackRate(animation: KsAnimation | null): number {
  return animation ? animation.playbackRate : 1;
}

function computedTimingFill(fill: Fill): Fill {
  return fill === "auto" ? "none" : fill;
}

function computedTimingDuration(duration: number | "auto"): number {
  return duration === "auto" ? 0 : duration;
}

function nullableTimingValue(value: number): number | null {
  return Number.isNaN(value) ? null : value;
}

export class KsKeyframeEffect extends KsAnimationEffect implements Idl.KeyframeEffect {
  #target: Idl.Element | null = null;
  #composite: "replace" | "add" | "accumulate" = "replace";
  _keyframes: Keyframe[] = [];
  constructor(target: unknown, keyframes?: unknown, options?: unknown) {
    super(ILLEGAL);
    if (target instanceof KsKeyframeEffect) {
      this.#target = target.#target;
      this.#composite = target.#composite;
      this._keyframes = target._keyframes.map((f) => ({ ...f, props: new Map(f.props) }));
      this._timing = { ...target._timing };
      return;
    }
    if (target !== null && !isTargetElement(target)) {
      throw new TypeError(
        "Failed to construct 'KeyframeEffect': parameter 1 is not of type 'Element'.",
      );
    }
    this.#target = target;
    this._keyframes = processKeyframes(keyframes);
    if (typeof options === "number") {
      applyTiming(this._timing, { duration: options });
    } else if (options !== undefined && options !== null) {
      applyTiming(this._timing, options);
      const composite: unknown =
        typeof options === "object" ? Reflect.get(options, "composite") : undefined;
      if (composite !== undefined)
        this.#composite = enumValue(
          composite,
          ["replace", "add", "accumulate"] as const,
          "CompositeOperation",
        );
    }
  }
  get target(): Idl.Element | null {
    return this.#target;
  }
  set target(value: Idl.Element | null) {
    if (value !== null && nodeIdOf(value) === 0)
      throw new TypeError("target must be an Element or null.");
    this.#target = value;
    this._changed();
  }
  // Limitation: no pseudo-element targets. The Rust side attaches script animations to
  // an element's own animation set, never to its ::before/::after sets.
  get pseudoElement(): string | null {
    return null;
  }
  set pseudoElement(_value: string | null) {}
  get composite(): "replace" | "add" | "accumulate" {
    return this.#composite;
  }
  // Limitation: add and accumulate composite as replace. Stylo samples each effect into
  // one map, last writer wins, with no underlying value to add to.
  set composite(value: "replace" | "add" | "accumulate") {
    this.#composite = enumValue(
      value,
      ["replace", "add", "accumulate"] as const,
      "CompositeOperation",
    );
  }
  getKeyframes(): object[] {
    return this._keyframes.map((f) => {
      const out: Record<string, unknown> = {
        offset: f.offset,
        computedOffset: f.computedOffset,
        easing: f.easing,
        composite: f.composite,
      };
      for (const [key, value] of f.props) out[key] = value;
      return out;
    });
  }
  setKeyframes(keyframes: object | null): void {
    this._keyframes = processKeyframes(keyframes);
    this._changed();
  }
}

export class KsAnimationPlaybackEvent extends KsEvent {
  readonly #currentTime: number | null;
  readonly #timelineTime: number | null;
  constructor(
    type: string,
    init?: ({ currentTime?: number | null; timelineTime?: number | null } & Idl.EventInit) | null,
  ) {
    super(type, init);
    this.#currentTime = init?.currentTime ?? null;
    this.#timelineTime = init?.timelineTime ?? null;
  }
  get currentTime(): number | null {
    return this.#currentTime;
  }
  get timelineTime(): number | null {
    return this.#timelineTime;
  }
}

type ListenerEntry = { callback: unknown; once: boolean; handler?: string };

let nextAnimationId = 1;
// Animations a page started but no longer references keep playing (they stay relevant),
// so the document holds them until they cancel, or finish without filling.
const relevantAnimations = new Set<KsAnimation>();
const released =
  typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry<number>((id) => {
        try {
          dom.waapiRemove(id);
        } catch {
          /* handle gone */
        }
      })
    : null;

function animationEffectEndTime(effect: KsAnimationEffect | null): number {
  return effect?._endTime() ?? 0;
}

function playbackStartTime(now: number, holdTime: number, rate: number): number {
  return rate === 0 ? now : now - holdTime / rate;
}

function isAnimationFinishedAt(current: number | null, rate: number, end: number): boolean {
  return current !== null && ((rate > 0 && current >= end) || (rate < 0 && current <= 0));
}

function needsForwardPlaySeek(current: number | null, end: number): boolean {
  return current === null || current < 0 || current >= end;
}

function needsReversePlaySeek(current: number | null, end: number): boolean {
  return current === null || current <= 0 || current > end;
}

function forwardPlaySeekTime(current: number | null, end: number): number | null {
  return needsForwardPlaySeek(current, end) ? 0 : null;
}

function reversePlaySeekTime(current: number | null, end: number): number | null {
  if (!needsReversePlaySeek(current, end)) return null;
  if (end === Infinity) {
    throw domException(
      "Cannot play reversed Animation with infinite target effect end.",
      "InvalidStateError",
    );
  }
  return end;
}

function playSeekTime(rate: number, current: number | null, end: number): number | null {
  if (rate > 0) return forwardPlaySeekTime(current, end);
  if (rate < 0) return reversePlaySeekTime(current, end);
  return current === null ? 0 : null;
}

function pausedAnimationTime(current: number | null, rate: number, end: number): number {
  if (current !== null) return current;
  if (rate >= 0) return 0;
  if (end === Infinity) {
    throw domException(
      "Cannot pause reversed Animation with infinite target effect end.",
      "InvalidStateError",
    );
  }
  return end;
}

function assertAnimationCanFinish(rate: number, end: number): void {
  if (rate === 0 || (rate > 0 && end === Infinity)) {
    throw domException(
      "Cannot finish Animation with a playbackRate of 0 or an infinite target effect end.",
      "InvalidStateError",
    );
  }
}

function animationFinishLimit(rate: number, end: number): number {
  return rate > 0 ? end : 0;
}

function keyframeEffectWithTarget(
  effect: KsAnimationEffect | null,
): { effect: KsKeyframeEffect; target: Idl.Element } | null {
  if (!(effect instanceof KsKeyframeEffect)) return null;
  const target = effect.target;
  if (!target) return null;
  return { effect, target };
}

function commitKeyframeStyles(
  effect: KsKeyframeEffect,
  target: Idl.Element,
  style: Idl.CSSStyleDeclaration,
): void {
  const computed = ksGlobal.getComputedStyle(target);
  const names = new Set(
    effect._keyframes.flatMap((frame) =>
      [...frame.props.keys()].map((key) => cssPropertyName(key) ?? ""),
    ),
  );
  for (const name of names) {
    if (name) style.setProperty(name, computed.getPropertyValue(name));
  }
}

function shouldRecomputeUnconstrainedTime(
  didSeek: boolean,
  holdTime: number | null,
  startTime: number | null,
): boolean {
  return !didSeek && holdTime !== null && startTime !== null;
}

function usableUnconstrainedTime(value: number | null, startTime: number | null): number | null {
  if (value === null || startTime === null) return null;
  return value;
}

function reachedPositiveEnd(rate: number, current: number, end: number): boolean {
  return rate > 0 && current >= end;
}

function reachedNegativeStart(rate: number, current: number): boolean {
  return rate < 0 && current <= 0;
}

function positiveFinishedHoldTime(
  didSeek: boolean,
  current: number,
  previous: number | null,
  end: number,
): number {
  return didSeek ? current : Math.max(previous ?? end, end);
}

function negativeFinishedHoldTime(
  didSeek: boolean,
  current: number,
  previous: number | null,
): number {
  return didSeek ? current : Math.min(previous ?? 0, 0);
}

function remainingFinishDelay(rate: number, current: number, end: number): number {
  return rate > 0 ? (end - current) / rate : current / -rate;
}

function activeAnimationTimeline(
  rate: number,
  timeline: KsAnimationTimeline | null,
): KsAnimationTimeline | null {
  if (rate === 0 || timeline === null || timeline.currentTime == null) return null;
  return timeline;
}

function shouldRebaseAnimationStart(didSeek: boolean, holdTime: number | null): boolean {
  return didSeek && holdTime !== null;
}

function animationFillsForwards(effect: KsAnimationEffect | null): boolean {
  const fill = effect?._timing.fill;
  return fill === "forwards" || fill === "both";
}

function isKeyframeEffectWithTarget(effect: KsAnimationEffect | null): effect is KsKeyframeEffect {
  return effect instanceof KsKeyframeEffect && !!effect.target;
}

function playbackStateDraws(state: string, fills: boolean, rate: number): boolean {
  return state !== "idle" && (state !== "finished" || fills || rate < 0);
}

function animationDraws(
  effect: KsAnimationEffect | null,
  state: string,
  fills: boolean,
  rate: number,
): effect is KsKeyframeEffect {
  return isKeyframeEffectWithTarget(effect) && playbackStateDraws(state, fills, rate);
}

function playbackEpochStart(
  origin: number | undefined,
  startTime: number | null,
): number | undefined {
  return startTime !== null && origin !== undefined ? origin + startTime : undefined;
}

function containsMethod(root: unknown): unknown {
  if (typeof root !== "object" || root === null) return undefined;
  return Reflect.get(root, "contains");
}

function rootContainsTarget(root: unknown, target: Idl.Element): boolean {
  const contains = containsMethod(root);
  if (typeof contains !== "function") return false;
  return Reflect.apply(contains, root, [target]) === true;
}

function activeAnimationTarget(animation: KsAnimation): Idl.Element | null {
  const effect = animation.effect;
  if (!(effect instanceof KsKeyframeEffect)) return null;
  const target = effect.target;
  if (!target || animation.playState === "idle") return null;
  return target;
}

function animationMatchesRoot(animation: KsAnimation, root: unknown, subtree: boolean): boolean {
  const target = activeAnimationTarget(animation);
  if (!target) return false;
  if (target === root) return true;
  if (!subtree) return false;
  return rootContainsTarget(root, target);
}

function invokeAnimationListener(callback: unknown, target: KsAnimation, event: Idl.Event): void {
  if (typeof callback === "function") {
    callback.call(target, event);
    return;
  }
  if (typeof callback !== "object" || callback === null) return;
  const handleEvent: unknown = Reflect.get(callback, "handleEvent");
  if (typeof handleEvent === "function") Reflect.apply(handleEvent, callback, [event]);
}

function reportAnimationListenerError(error: unknown): void {
  try {
    console.error("[kitesurf] animation listener threw:", error);
  } catch {
    /* console clobbered */
  }
}

export class KsAnimation implements Idl.Animation {
  readonly _ksId = nextAnimationId++;
  #id = "";
  #effect: KsAnimationEffect | null = null;
  #timeline: KsAnimationTimeline | null;
  #startTime: number | null = null;
  #holdTime: number | null = null;
  #rate = 1;
  #previousCurrentTime: number | null = null;
  #ready!: Promise<KsAnimation>;
  #finished!: Promise<KsAnimation>;
  #resolveFinished!: (a: KsAnimation) => void;
  #rejectFinished!: (e: unknown) => void;
  #finishedSettled = false;
  #finishTimer = 0;
  #listeners = new Map<string, ListenerEntry[]>();
  #handlers = new Map<string, Idl.EventHandlerNonNull>();
  #pushedEffect = false;
  #effectStale = false;

  constructor(effect: KsAnimationEffect | null = null, timeline?: KsAnimationTimeline | null) {
    this.#timeline = timeline === undefined ? getDocumentTimeline() : timeline;
    this.#ready = Promise.resolve(this);
    this.#newFinishedPromise();
    if (effect) this.effect = effect;
    released?.register(this, this._ksId);
  }

  #timelineCurrentTime(): number | null {
    return this.#timeline?.currentTime ?? null;
  }

  #resumeFromHoldTime(): void {
    const holdTime = this.#holdTime;
    if (holdTime === null) return;
    const now = this.#timelineCurrentTime();
    if (now === null) {
      this.#startTime = null;
      return;
    }
    this.#startTime = playbackStartTime(now, holdTime, this.#rate);
    if (this.#rate !== 0) this.#holdTime = null;
  }

  #startAtFinish(limit: number, now: number | null): void {
    if (this.#startTime === null && now !== null) {
      this.#startTime = now - limit / this.#rate;
      this.#holdTime = null;
    }
  }

  get id(): string {
    return this.#id;
  }
  set id(value: string) {
    this.#id = String(value);
  }
  get effect(): KsAnimationEffect | null {
    return this.#effect;
  }
  set effect(value: KsAnimationEffect | null) {
    if (value === this.#effect) return;
    if (value !== null && !(value instanceof KsAnimationEffect))
      throw new TypeError("effect must be an AnimationEffect or null.");
    if (this.#effect) this.#effect._animation = null;
    if (value?._animation) value._animation.effect = null;
    this.#effect = value;
    if (value) value._animation = this;
    this._effectChanged();
  }
  get timeline(): KsAnimationTimeline | null {
    return this.#timeline;
  }
  set timeline(value: KsAnimationTimeline | null) {
    const previous = this.currentTime;
    this.#timeline = value;
    if (previous !== null) this.#silentlySetCurrentTime(previous);
    this.#updateFinishedState(false, false);
  }
  get startTime(): number | null {
    return this.#startTime;
  }
  set startTime(value: number | null) {
    const time = value === null ? null : finiteDouble(value, "startTime");
    const timelineTime = this.#timeline?.currentTime ?? null;
    if (timelineTime === null && time !== null) this.#holdTime = null;
    const previous = this.currentTime;
    this.#startTime = time;
    if (time !== null) this.#holdTime = this.#rate !== 0 ? null : previous;
    else this.#holdTime = previous;
    this.#updateFinishedState(true, false);
  }
  get currentTime(): number | null {
    const holdTime = this.#holdTime;
    const timelineTime = this.#timelineCurrentTime();
    const startTime = this.#startTime;
    const rate = this.#rate;
    if (holdTime !== null) return holdTime;
    if (timelineTime === null || startTime === null) return null;
    return (timelineTime - startTime) * rate;
  }
  set currentTime(value: number | null) {
    if (value === null) {
      if (this.currentTime !== null) throw new TypeError("currentTime cannot be set to null.");
      return;
    }
    this.#silentlySetCurrentTime(finiteDouble(value, "currentTime"));
    this.#updateFinishedState(true, false);
  }
  get playbackRate(): number {
    return this.#rate;
  }
  set playbackRate(value: number) {
    const previous = this.currentTime;
    this.#rate = finiteDouble(value, "playbackRate");
    if (previous !== null) this.#silentlySetCurrentTime(previous);
    this.#updateFinishedState(true, false);
  }
  get playState(): "idle" | "running" | "paused" | "finished" {
    const current = this.currentTime;
    if (current === null && this.#startTime === null) return "idle";
    if (this.#startTime === null) return "paused";
    return isAnimationFinishedAt(current, this.#rate, animationEffectEndTime(this.#effect))
      ? "finished"
      : "running";
  }
  get replaceState(): "active" {
    return "active";
  }
  get pending(): boolean {
    return false;
  }
  get ready(): Promise<KsAnimation> {
    return this.#ready;
  }
  get finished(): Promise<KsAnimation> {
    return this.#finished;
  }
  get onfinish(): Idl.EventHandler {
    return this.#handler("finish");
  }
  set onfinish(v: Idl.EventHandler) {
    this.#setHandler("finish", v);
  }
  get oncancel(): Idl.EventHandler {
    return this.#handler("cancel");
  }
  set oncancel(v: Idl.EventHandler) {
    this.#setHandler("cancel", v);
  }
  get onremove(): Idl.EventHandler {
    return this.#handler("remove");
  }
  set onremove(v: Idl.EventHandler) {
    this.#setHandler("remove", v);
  }

  play(): void {
    const end = animationEffectEndTime(this.#effect);
    const seek = playSeekTime(this.#rate, this.currentTime, end);
    if (seek !== null) this.#holdTime = seek;
    this.#resumeFromHoldTime();
    this.#ready = Promise.resolve(this);
    relevantAnimations.add(this);
    this.#updateFinishedState(false, false);
  }
  pause(): void {
    if (this.playState === "paused") return;
    this.#holdTime = pausedAnimationTime(
      this.currentTime,
      this.#rate,
      animationEffectEndTime(this.#effect),
    );
    this.#startTime = null;
    this.#ready = Promise.resolve(this);
    relevantAnimations.add(this);
    this.#updateFinishedState(false, false);
  }
  finish(): void {
    const end = animationEffectEndTime(this.#effect);
    assertAnimationCanFinish(this.#rate, end);
    const limit = animationFinishLimit(this.#rate, end);
    this.#silentlySetCurrentTime(limit);
    this.#startAtFinish(limit, this.#timelineCurrentTime());
    this.#updateFinishedState(true, true);
  }
  cancel(): void {
    if (this.playState !== "idle") {
      this.#ready = Promise.resolve(this);
      if (!this.#finishedSettled) {
        this.#finished.catch(() => {});
        this.#rejectFinished(domException("The user aborted a request.", "AbortError"));
      }
      this.#newFinishedPromise();
      const timelineTime = this.#timeline?.currentTime ?? null;
      scheduleTask(() => this.#fire("cancel", null, timelineTime), 0);
    }
    this.#holdTime = null;
    this.#startTime = null;
    this.#previousCurrentTime = null;
    relevantAnimations.delete(this);
    this.#sync();
  }
  reverse(): void {
    if (this.#timeline === null)
      throw domException("Cannot reverse an Animation with no timeline.", "InvalidStateError");
    const original = this.#rate;
    const previous = this.currentTime;
    this.#rate = -original;
    if (previous !== null) this.#silentlySetCurrentTime(previous);
    try {
      this.play();
    } catch (e) {
      this.#rate = original;
      if (previous !== null) this.#silentlySetCurrentTime(previous);
      throw e;
    }
  }
  updatePlaybackRate(rate: number): void {
    this.playbackRate = rate;
  }
  persist(): void {}
  commitStyles(): void {
    const entry = keyframeEffectWithTarget(this.#effect);
    if (!entry) return;
    const style: unknown = Reflect.get(entry.target, "style");
    if (!isStyleDeclaration(style)) return;
    commitKeyframeStyles(entry.effect, entry.target, style);
  }

  addEventListener(type: string, callback: unknown, options?: boolean | { once?: boolean }): void {
    if (callback === null || callback === undefined) return;
    const list = this.#listeners.get(type) ?? [];
    if (list.some((listener) => listener.callback === callback && !listener.handler)) return;
    list.push({ callback, once: typeof options === "object" && !!options?.once });
    this.#listeners.set(type, list);
  }
  removeEventListener(type: string, callback: unknown): void {
    const list = this.#listeners.get(type);
    const at = list?.findIndex((l) => l.callback === callback && !l.handler) ?? -1;
    if (list && at >= 0) list.splice(at, 1);
  }
  dispatchEvent(event: Idl.Event): boolean {
    const list = this.#listeners.get(event.type);
    setEventTarget(event, this);
    setEventCurrentTarget(event, this);
    for (const entry of list?.slice() ?? []) this.#dispatchListener(event, entry);
    setEventCurrentTarget(event, null);
    return !event.defaultPrevented;
  }

  #dispatchListener(event: Idl.Event, entry: ListenerEntry): void {
    if (entry.once) this.removeEventListener(event.type, entry.callback);
    const callback = entry.handler ? this.#handlers.get(entry.handler) : entry.callback;
    try {
      invokeAnimationListener(callback, this, event);
    } catch (error) {
      reportAnimationListenerError(error);
    }
  }

  #handler(type: string): Idl.EventHandler {
    return this.#handlers.get(type) ?? null;
  }

  #setHandler(type: string, value: unknown): void {
    const fn = isEventHandler(value) ? value : null;
    const list = this.#listeners.get(type) ?? [];
    const at = list.findIndex((l) => l.handler === type);
    if (fn === null) this.#removeHandler(type, list, at);
    else this.#installHandler(type, fn, list, at);
    this.#listeners.set(type, list);
  }

  #removeHandler(type: string, list: ListenerEntry[], at: number): void {
    this.#handlers.delete(type);
    if (at >= 0) list.splice(at, 1);
  }

  #installHandler(
    type: string,
    handler: Idl.EventHandlerNonNull,
    list: ListenerEntry[],
    at: number,
  ): void {
    this.#handlers.set(type, handler);
    if (at < 0) list.push({ callback: null, once: false, handler: type });
  }

  #fire(type: string, currentTime: number | null, timelineTime: number | null): void {
    this.dispatchEvent(new KsAnimationPlaybackEvent(type, { currentTime, timelineTime }));
  }

  #newFinishedPromise(): void {
    this.#finishedSettled = false;
    this.#finished = new Promise<KsAnimation>((resolve, reject) => {
      this.#resolveFinished = resolve;
      this.#rejectFinished = reject;
    });
  }

  #silentlySetCurrentTime(seek: number): void {
    const now = this.#timeline?.currentTime ?? null;
    if (this.#holdTime !== null || this.#startTime === null || now === null || this.#rate === 0) {
      this.#holdTime = seek;
    } else {
      this.#startTime = now - seek / this.#rate;
    }
    if (now === null) this.#startTime = null;
    this.#previousCurrentTime = null;
  }

  // web-animations-1 §4.4.14. A natural finish freezes current time at the end via the hold
  // time; the timer stands in for the per-frame update a browser would run to notice it.
  #updateFinishedState(didSeek: boolean, synchronously: boolean): void {
    const end = animationEffectEndTime(this.#effect);
    const unconstrained = this.#unconstrainedCurrentTime(didSeek);
    this.#applyFinishedHoldTime(unconstrained, end, didSeek);
    this.#previousCurrentTime = this.currentTime;
    const finished = this.playState === "finished";
    this.#updateFinishedPromise(finished, synchronously);
    this.#armFinishTimer();
    this.#sync();
  }

  #unconstrainedCurrentTime(didSeek: boolean): number | null {
    if (!shouldRecomputeUnconstrainedTime(didSeek, this.#holdTime, this.#startTime)) {
      return this.currentTime;
    }
    const startTime = this.#startTime;
    if (startTime === null) return null;
    const now = this.#timelineCurrentTime();
    return now === null ? null : (now - startTime) * this.#rate;
  }

  #applyFinishedHoldTime(unconstrained: number | null, end: number, didSeek: boolean): void {
    const current = usableUnconstrainedTime(unconstrained, this.#startTime);
    if (current === null) return;
    if (reachedPositiveEnd(this.#rate, current, end)) {
      this.#holdTime = positiveFinishedHoldTime(didSeek, current, this.#previousCurrentTime, end);
      return;
    }
    if (reachedNegativeStart(this.#rate, current)) {
      this.#holdTime = negativeFinishedHoldTime(didSeek, current, this.#previousCurrentTime);
      return;
    }
    this.#clearFinishedHoldTime(didSeek);
  }

  #clearFinishedHoldTime(didSeek: boolean): void {
    const timeline = activeAnimationTimeline(this.#rate, this.#timeline);
    if (!timeline) return;
    const holdTime = this.#holdTime;
    if (holdTime !== null && shouldRebaseAnimationStart(didSeek, holdTime)) {
      this.#startTime = Number(timeline.currentTime) - holdTime / this.#rate;
    }
    this.#holdTime = null;
  }

  #updateFinishedPromise(finished: boolean, synchronously: boolean): void {
    if (finished && !this.#finishedSettled) {
      this.#queueFinishNotification(synchronously);
    } else if (!finished && this.#finishedSettled) {
      this.#newFinishedPromise();
    }
  }

  #queueFinishNotification(synchronously: boolean): void {
    const notify = () => this.#notifyFinished();
    if (synchronously) notify();
    else queueMicrotask(notify);
  }

  #notifyFinished(): void {
    if (this.playState !== "finished" || this.#finishedSettled) return;
    this.#finishedSettled = true;
    this.#resolveFinished(this);
    const current = this.currentTime;
    const timelineTime = this.#timelineCurrentTime();
    scheduleTask(() => this.#fire("finish", current, timelineTime), 0);
    this.#sync();
  }

  #armFinishTimer(): void {
    const generation = ++this.#finishTimer;
    if (this.playState === "running") this.#scheduleFinishCheck(generation);
  }

  #scheduleFinishCheck(generation: number): void {
    const current = this.currentTime ?? 0;
    const end = animationEffectEndTime(this.#effect);
    const remaining = remainingFinishDelay(this.#rate, current, end);
    if (!Number.isFinite(remaining)) return;
    scheduleTask(
      () => {
        if (generation === this.#finishTimer) this.#updateFinishedState(false, false);
      },
      Math.max(0, Math.ceil(remaining)),
    );
  }

  _effectChanged(): void {
    this.#effectStale = true;
    this.#updateFinishedState(false, false);
  }

  // Mirrors this animation into Rust: the effect while it can draw, the playback always.
  // A finished animation that doesn't fill forwards draws nothing, so it lets go.
  #sync(): void {
    const effect = this.#effect;
    const state = this.playState;
    const fills = animationFillsForwards(effect);
    try {
      if (animationDraws(effect, state, fills, this.#rate)) this.#syncDrawingEffect(effect);
      else this.#removeDrawingEffect(state, fills);
    } catch {
      /* the handle is gone with its navigate */
    }
    bumpMutationSeq("style");
  }

  #syncDrawingEffect(effect: KsKeyframeEffect): void {
    if (!this.#pushedEffect || this.#effectStale) this.#pushEffect(effect);
    const origin = this.#timeline?._originEpoch;
    const start = playbackEpochStart(origin, this.#startTime);
    dom.waapiSetPlayback(this._ksId, start, this.#holdTime ?? undefined, this.#rate);
  }

  #pushEffect(effect: KsKeyframeEffect): void {
    const timing = effect._timing;
    dom.waapiSetEffect(
      this._ksId,
      nodeIdOf(effect.target),
      keyframesJson(effect._keyframes),
      new Float64Array(timingArray(timing)),
      timing.easing,
    );
    this.#pushedEffect = true;
    this.#effectStale = false;
  }

  #removeDrawingEffect(state: string, fills: boolean): void {
    if (this.#pushedEffect) dom.waapiRemove(this._ksId);
    this.#pushedEffect = false;
    this.#effectStale = false;
    if (state === "finished" && !fills) relevantAnimations.delete(this);
  }
}

export function animateElement(
  element: unknown,
  keyframes: unknown,
  options?: unknown,
): KsAnimation {
  const effect = new KsKeyframeEffect(element, keyframes, options);
  const animation = new KsAnimation(effect, getDocumentTimeline());
  if (options !== null && typeof options === "object") {
    const id: unknown = Reflect.get(options, "id");
    if (id !== undefined) animation.id = String(id);
  }
  animation.play();
  return animation;
}

// getAnimations(): live animations whose effect targets `root`, or with `subtree` any
// element inside it, in composite order (creation order, as ids are minted).
export function animationsFor(root: unknown, subtree: boolean): KsAnimation[] {
  const out: KsAnimation[] = [];
  for (const animation of relevantAnimations) {
    if (animationMatchesRoot(animation, root, subtree)) out.push(animation);
  }
  return out.sort((a, b) => a._ksId - b._ksId);
}
