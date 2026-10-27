// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Web Animations (web-animations-1): Element.animate, Animation, KeyframeEffect, timelines.
// Timing math and interpolation live in Rust (core waapi.rs); this owns the playback model.

import type * as Idl from "./idl/types.generated.js";
import { KsEvent, setEventCurrentTarget, setEventTarget } from "./events/event.js";
import { bumpMutationSeq } from "./mutations/seq.js";
import { dom, ksGlobal } from "./state.js";
import { ksInternals } from "./internals.js";

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
  // updateClockFloor only ever stores a finite number.
  return Math.max(Date.now(), ksInternals.clockFloorMs ?? 0);
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

// Members are read in IDL dictionary order (alphabetical), then validated together so a
// bad member leaves the timing untouched, as updateTiming() requires.
function applyTiming(state: TimingState, input: unknown): void {
  if (input === undefined || input === null) return;
  if (typeof input !== "object" && typeof input !== "function") {
    throw new TypeError("Failed to convert value to 'OptionalEffectTiming'.");
  }
  const read = (member: string): unknown => Reflect.get(input, member);
  const next = { ...state };
  const delay = read("delay");
  if (delay !== undefined) next.delay = finiteDouble(delay, "delay");
  const direction = read("direction");
  if (direction !== undefined)
    next.direction = enumValue(direction, DIRECTIONS, "PlaybackDirection");
  const duration = read("duration");
  if (duration !== undefined) {
    if (typeof duration === "string") {
      if (duration !== "auto") throw new TypeError(`Invalid duration '${duration}'.`);
      next.duration = "auto";
    } else {
      const n = Number(duration);
      if (Number.isNaN(n) || n < 0)
        throw new TypeError("Effect duration must be a non-negative number or 'auto'.");
      next.duration = n;
    }
  }
  const easing = read("easing");
  if (easing !== undefined) next.easing = String(easing);
  const endDelay = read("endDelay");
  if (endDelay !== undefined) next.endDelay = finiteDouble(endDelay, "endDelay");
  const fill = read("fill");
  if (fill !== undefined) next.fill = enumValue(fill, FILLS, "FillMode");
  const iterationStart = read("iterationStart");
  if (iterationStart !== undefined) {
    const n = finiteDouble(iterationStart, "iterationStart");
    if (n < 0) throw new TypeError("iterationStart must be non-negative.");
    next.iterationStart = n;
  }
  const iterations = read("iterations");
  if (iterations !== undefined) {
    const n = Number(iterations);
    if (Number.isNaN(n) || n < 0) throw new TypeError("iterations must be non-negative.");
    next.iterations = n;
  }
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
function cssPropertyName(key: string): string | null {
  if (key.startsWith("--")) return key;
  if (key === "cssFloat") return "float";
  if (key === "cssOffset") return "offset";
  if (key.includes("-") || key === "float") return null;
  const css = key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
  return css.startsWith("webkit-") ? "-" + css : css;
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

// web-animations-1 §5.3.3 "compute missing keyframe offsets": the ends default to 0
// and 1, and the keyframes between two known offsets spread evenly across them.
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

function validateOffsets(frames: Keyframe[]): void {
  let floor = -Infinity;
  for (const f of frames) {
    if (f.offset === null) continue;
    if (f.offset < 0 || f.offset > 1)
      throw new TypeError("Offsets must be null or in the range [0,1].");
    if (f.offset < floor) throw new TypeError("Offsets must be monotonically non-decreasing.");
    floor = f.offset;
  }
}

function processKeyframes(input: unknown): Keyframe[] {
  if (input === undefined || input === null) return [];
  if (typeof input !== "object" && typeof input !== "function") {
    throw new TypeError("Keyframes argument must be an object.");
  }
  const method: unknown = Reflect.get(input, Symbol.iterator);
  const frames: Keyframe[] = [];
  if (method !== undefined && method !== null) {
    if (!isIterable(input)) throw new TypeError("Keyframes argument is not iterable.");
    for (const entry of Array.from(input)) {
      let k: object;
      if (entry === undefined || entry === null) k = {};
      else if (typeof entry === "object") k = entry;
      else throw new TypeError("Keyframes must be objects.");
      const props = new Map<string, string>();
      for (const key of Object.keys(k)) {
        if (!RESERVED_KEYFRAME_KEYS.has(key) && cssPropertyName(key))
          props.set(key, String(Reflect.get(k, key)));
      }
      const easing: unknown = Reflect.get(k, "easing");
      const composite: unknown = Reflect.get(k, "composite");
      frames.push({
        offset: keyframeOffset(Reflect.get(k, "offset")),
        computedOffset: NaN,
        easing: easing === undefined ? "linear" : String(easing),
        composite:
          composite === undefined || composite === null
            ? "auto"
            : enumValue(composite, COMPOSITES, "CompositeOperationOrAuto"),
        props,
      });
    }
  } else {
    const byOffset = new Map<number, Map<string, string>>();
    for (const key of Object.keys(input).sort()) {
      if (RESERVED_KEYFRAME_KEYS.has(key) || !cssPropertyName(key)) continue;
      const values = toList(Reflect.get(input, key)).map(String);
      values.forEach((value, i) => {
        const at = values.length === 1 ? 1 : i / (values.length - 1);
        let props = byOffset.get(at);
        if (!props) byOffset.set(at, (props = new Map()));
        props.set(key, value);
      });
    }
    for (const [at, props] of [...byOffset.entries()].sort((a, b) => a[0] - b[0])) {
      frames.push({ offset: null, computedOffset: at, easing: "linear", composite: "auto", props });
    }
    const offset: unknown = Reflect.get(input, "offset");
    const offsets = offset === undefined ? [] : toList(offset);
    offsets.slice(0, frames.length).forEach((o, i) => {
      frames[i].offset = keyframeOffset(o);
    });
    const easing: unknown = Reflect.get(input, "easing");
    const easings = easing === undefined ? [] : toList(easing).map(String);
    if (easings.length)
      frames.forEach((f, i) => {
        f.easing = easings[i % easings.length];
      });
    const composite: unknown = Reflect.get(input, "composite");
    const composites = composite === undefined ? [] : toList(composite);
    if (composites.length) {
      frames.forEach((f, i) => {
        f.composite = enumValue(
          composites[i % composites.length],
          COMPOSITES,
          "CompositeOperationOrAuto",
        );
      });
    }
    if (offsets.length === 0) {
      for (const f of frames) f.offset = null;
      validateOffsets(frames);
      for (const f of frames) checkEasing(f.easing);
      return frames;
    }
  }
  validateOffsets(frames);
  computeMissingOffsets(frames);
  for (const f of frames) checkEasing(f.easing);
  return frames;
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
    const localTime = anim ? anim.currentTime : null;
    const out = dom.waapiComputedTiming(
      new Float64Array(timingArray(t)),
      t.easing,
      localTime ?? undefined,
      anim ? anim.playbackRate : 1,
    );
    const orNull = (n: number) => (Number.isNaN(n) ? null : n);
    return {
      ...this.getTiming(),
      fill: t.fill === "auto" ? "none" : t.fill,
      duration: t.duration === "auto" ? 0 : t.duration,
      activeDuration: out[1],
      endTime: out[2],
      localTime,
      progress: orNull(out[3]),
      currentIteration: orNull(out[4]),
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

export class KsKeyframeEffect extends KsAnimationEffect implements Idl.KeyframeEffect {
  #target: Idl.Element | null = null;
  #composite: "replace" | "add" | "accumulate" = "replace";
  _keyframes: Keyframe[] = [];
  // The copy constructor's KeyframeEffect source, or a target element.
  constructor(
    target: Idl.Element | Idl.KeyframeEffect | null,
    keyframes?: object | null,
    options?: number | Idl.KeyframeEffectOptions,
  ) {
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
      const composite = typeof options === "object" ? options.composite : undefined;
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

type ListenerEntry = { callback: Idl.EventListener | null; once: boolean; handler?: string };

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
    if (this.#holdTime !== null) return this.#holdTime;
    const timelineTime = this.#timeline?.currentTime ?? null;
    if (timelineTime === null || this.#startTime === null) return null;
    return (timelineTime - this.#startTime) * this.#rate;
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
    const end = this.#effect?._endTime() ?? 0;
    if (
      current !== null &&
      ((this.#rate > 0 && current >= end) || (this.#rate < 0 && current <= 0))
    )
      return "finished";
    return "running";
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
    const end = this.#effect?._endTime() ?? 0;
    const current = this.currentTime;
    let seek: number | null = null;
    if (this.#rate > 0 && (current === null || current < 0 || current >= end)) seek = 0;
    else if (this.#rate < 0 && (current === null || current <= 0 || current > end)) {
      if (end === Infinity)
        throw domException(
          "Cannot play reversed Animation with infinite target effect end.",
          "InvalidStateError",
        );
      seek = end;
    } else if (this.#rate === 0 && current === null) seek = 0;
    if (seek !== null) this.#holdTime = seek;
    if (this.#holdTime !== null) {
      const now = this.#timeline?.currentTime ?? null;
      if (now !== null) {
        this.#startTime = this.#rate === 0 ? now : now - this.#holdTime / this.#rate;
        if (this.#rate !== 0) this.#holdTime = null;
      } else {
        this.#startTime = null;
      }
    }
    this.#ready = Promise.resolve(this);
    relevantAnimations.add(this);
    this.#updateFinishedState(false, false);
  }
  pause(): void {
    if (this.playState === "paused") return;
    let current = this.currentTime;
    if (current === null) {
      if (this.#rate >= 0) current = 0;
      else {
        const end = this.#effect?._endTime() ?? 0;
        if (end === Infinity)
          throw domException(
            "Cannot pause reversed Animation with infinite target effect end.",
            "InvalidStateError",
          );
        current = end;
      }
    }
    this.#holdTime = current;
    this.#startTime = null;
    this.#ready = Promise.resolve(this);
    relevantAnimations.add(this);
    this.#updateFinishedState(false, false);
  }
  finish(): void {
    const end = this.#effect?._endTime() ?? 0;
    if (this.#rate === 0 || (this.#rate > 0 && end === Infinity)) {
      throw domException(
        "Cannot finish Animation with a playbackRate of 0 or an infinite target effect end.",
        "InvalidStateError",
      );
    }
    const limit = this.#rate > 0 ? end : 0;
    this.#silentlySetCurrentTime(limit);
    const now = this.#timeline?.currentTime ?? null;
    if (this.#startTime === null && now !== null) {
      this.#startTime = now - limit / this.#rate;
      this.#holdTime = null;
    }
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
    const effect = this.#effect;
    if (!(effect instanceof KsKeyframeEffect) || !effect.target) return;
    const style: unknown = Reflect.get(effect.target, "style");
    if (!isStyleDeclaration(style)) return;
    const computed = ksGlobal.getComputedStyle(effect.target);
    const names = new Set(
      effect._keyframes.flatMap((f) => [...f.props.keys()].map((k) => cssPropertyName(k) ?? "")),
    );
    for (const name of names) if (name) style.setProperty(name, computed.getPropertyValue(name));
  }

  addEventListener(
    type: string,
    callback: Idl.EventListener | null,
    options?: boolean | Idl.AddEventListenerOptions,
  ): void {
    if (callback === null || callback === undefined) return;
    const list = this.#listeners.get(type) ?? [];
    if (list.some((l) => l.callback === callback && !l.handler)) return;
    list.push({ callback, once: typeof options === "object" && !!options?.once });
    this.#listeners.set(type, list);
  }
  removeEventListener(type: string, callback: Idl.EventListener | null): void {
    const list = this.#listeners.get(type);
    const at = list?.findIndex((l) => l.callback === callback && !l.handler) ?? -1;
    if (list && at >= 0) list.splice(at, 1);
  }
  dispatchEvent(event: Idl.Event): boolean {
    const list = this.#listeners.get(event.type);
    setEventTarget(event, this);
    setEventCurrentTarget(event, this);
    for (const entry of list ? list.slice() : []) {
      if (entry.once) this.removeEventListener(event.type, entry.callback);
      const cb = entry.handler ? this.#handlers.get(entry.handler) : entry.callback;
      try {
        if (typeof cb === "function") cb.call(this, event);
        else if (typeof cb === "object" && cb !== null) {
          const handleEvent = cb.handleEvent;
          if (typeof handleEvent === "function") Reflect.apply(handleEvent, cb, [event]);
        }
      } catch (err) {
        try {
          console.error("[kitesurf] animation listener threw:", err);
        } catch {
          /* console clobbered */
        }
      }
    }
    setEventCurrentTarget(event, null);
    return !event.defaultPrevented;
  }

  #handler(type: string): Idl.EventHandler {
    return this.#handlers.get(type) ?? null;
  }

  #setHandler(type: string, value: unknown): void {
    const fn = isEventHandler(value) ? value : null;
    const list = this.#listeners.get(type) ?? [];
    const at = list.findIndex((l) => l.handler === type);
    if (fn === null) {
      this.#handlers.delete(type);
      if (at >= 0) list.splice(at, 1);
    } else {
      this.#handlers.set(type, fn);
      if (at < 0) list.push({ callback: null, once: false, handler: type });
    }
    this.#listeners.set(type, list);
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
    const end = this.#effect?._endTime() ?? 0;
    let unconstrained = this.currentTime;
    if (!didSeek && this.#holdTime !== null && this.#startTime !== null) {
      const now = this.#timeline?.currentTime ?? null;
      unconstrained = now === null ? null : (now - this.#startTime) * this.#rate;
    }
    if (unconstrained !== null && this.#startTime !== null) {
      if (this.#rate > 0 && unconstrained >= end) {
        this.#holdTime = didSeek ? unconstrained : Math.max(this.#previousCurrentTime ?? end, end);
      } else if (this.#rate < 0 && unconstrained <= 0) {
        this.#holdTime = didSeek ? unconstrained : Math.min(this.#previousCurrentTime ?? 0, 0);
      } else if (this.#rate !== 0 && this.#timeline?.currentTime != null) {
        if (didSeek && this.#holdTime !== null) {
          this.#startTime = this.#timeline.currentTime - this.#holdTime / this.#rate;
        }
        this.#holdTime = null;
      }
    }
    this.#previousCurrentTime = this.currentTime;
    const finished = this.playState === "finished";
    if (finished && !this.#finishedSettled) {
      const notify = () => {
        if (this.playState !== "finished" || this.#finishedSettled) return;
        this.#finishedSettled = true;
        this.#resolveFinished(this);
        const current = this.currentTime;
        const timelineTime = this.#timeline?.currentTime ?? null;
        scheduleTask(() => this.#fire("finish", current, timelineTime), 0);
        this.#sync();
      };
      if (synchronously) notify();
      else queueMicrotask(notify);
    } else if (!finished && this.#finishedSettled) {
      this.#newFinishedPromise();
    }
    this.#armFinishTimer();
    this.#sync();
  }

  #armFinishTimer(): void {
    const generation = ++this.#finishTimer;
    if (this.playState !== "running") return;
    const current = this.currentTime ?? 0;
    const end = this.#effect?._endTime() ?? 0;
    const remaining = this.#rate > 0 ? (end - current) / this.#rate : current / -this.#rate;
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
    const fill = effect?._timing.fill;
    const fills = fill === "forwards" || fill === "both";
    const draws =
      effect instanceof KsKeyframeEffect &&
      !!effect.target &&
      state !== "idle" &&
      (state !== "finished" || fills || this.#rate < 0);
    try {
      if (!draws) {
        if (this.#pushedEffect) dom.waapiRemove(this._ksId);
        this.#pushedEffect = false;
        this.#effectStale = false;
        if (state === "finished" && !fills) relevantAnimations.delete(this);
      } else {
        if (!this.#pushedEffect || this.#effectStale) {
          const t = effect._timing;
          dom.waapiSetEffect(
            this._ksId,
            nodeIdOf(effect.target),
            keyframesJson(effect._keyframes),
            new Float64Array(timingArray(t)),
            t.easing,
          );
          this.#pushedEffect = true;
          this.#effectStale = false;
        }
        const origin = this.#timeline?._originEpoch;
        const start =
          this.#startTime !== null && origin !== undefined ? origin + this.#startTime : undefined;
        dom.waapiSetPlayback(this._ksId, start, this.#holdTime ?? undefined, this.#rate);
      }
    } catch {
      /* the handle is gone with its navigate */
    }
    bumpMutationSeq("style");
  }
}

export function animateElement(
  element: Idl.Element,
  keyframes: object | null,
  options?: number | Idl.KeyframeAnimationOptions,
): KsAnimation {
  const effect = new KsKeyframeEffect(element, keyframes, options);
  const animation = new KsAnimation(effect, getDocumentTimeline());
  if (options !== null && typeof options === "object") {
    const id = options.id;
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
    const effect = animation.effect;
    const target = effect instanceof KsKeyframeEffect ? effect.target : null;
    if (!target || animation.playState === "idle") continue;
    const contains: unknown =
      subtree && typeof root === "object" && root !== null
        ? Reflect.get(root, "contains")
        : undefined;
    if (
      target === root ||
      (typeof contains === "function" && Reflect.apply(contains, root, [target]) === true)
    ) {
      out.push(animation);
    }
  }
  return out.sort((a, b) => a._ksId - b._ksId);
}
