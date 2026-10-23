// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements page IntersectionObserver callbacks from layout geometry and task scheduling.

import { ensurePaintDom, invalidatePaintDom } from "./paint.ts";
import { getInternalState } from "./internal-state.js";
import { ksEventCtors, ksGlobal, state } from "./state.ts";
import { pushException } from "./exception-buffer.ts";
import type { DomRect as Rect } from "./types.ts";

const MIN_VISIBILITY_DELAY_MS = 100;

const POLL_INTERVAL_MS = 100;
const FRAME_MS = 16;

const MAX_FORCED_BACKOFF_MS = 250;
const MAX_ROOT_MARGIN_COMPONENTS = 4;

type Margin = { value: number; percent: boolean };

type EntryData = {
  time: number;
  target: any;
  rootBounds: Rect | null;
  boundingClientRect: Rect;
  intersectionRect: Rect;
  isIntersecting: boolean;
  isVisible: boolean;
  intersectionRatio: number;
};

type IntersectionGeometry = {
  target: Rect;
  rootBounds: Rect | null;
  intersectionRect: Rect;
  isIntersecting: boolean;
  intersectionRatio: number;
  isVisible?: boolean;
};

type ObserverRecord = EntryData | null | undefined;

type ObserverInstance = {
  _callback: (entries: any[], observer: any) => void;
  _targets: Map<any, ObserverRecord>;
  _pending: any[];
  _delivery: true | null;
  _margins: Margin[];
  _scrollMargins: Margin[];
  _root: any;
  _rootId: number;
  _thresholds: readonly number[];
  _delay: number;
  _trackVisibility: boolean;
  _check: (target: any, resolve: boolean) => void;
  _checkAll: (resolve: boolean) => void;
  takeRecords: () => any[];
};

const active = new Set<ObserverInstance>();
let timer: unknown = null;
let installedWindow: any = null;
let gate: string | null = null;
let scrollTask: true | null = null;
let setTask: ((callback: () => void, ms?: number) => unknown) | null = null;
let clearTask: ((id: unknown) => void) | null = null;
let forcedBackoffMs = 0;
let lastForcedAt = 0;
const stats = { free: 0, forced: 0, skipped: 0 };

export function intersectionObserverStats(): { free: number; forced: number; skipped: number } {
  return { ...stats };
}

function zeroRect(): Rect {
  return {
    x: 0,
    y: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    width: 0,
    height: 0,
  };
}

function rect(value: any): Rect | null {
  try {
    return readBoundingRect(value);
  } catch {
    return null;
  }
}

function readBoundingRect(value: any): Rect | null {
  const result = value?.getBoundingClientRect?.();
  if (!result) return null;
  const out = rectFromFields(result);
  return Object.values(out).every(Number.isFinite) ? out : null;
}

function rectFromFields(result: any): Rect {
  return {
    x: Number(result.x),
    y: Number(result.y),
    top: Number(result.top),
    right: Number(result.right),
    bottom: Number(result.bottom),
    left: Number(result.left),
    width: Number(result.width),
    height: Number(result.height),
  };
}

function viewport(win: any): Rect {
  const width = Math.max(0, Number(win?.innerWidth) || 0);
  const height = Math.max(0, Number(win?.innerHeight) || 0);
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
  };
}

function syntaxError(message: string): Error {
  const DOMExceptionConstructor = ksGlobal.DOMException;
  if (typeof DOMExceptionConstructor === "function") {
    return new DOMExceptionConstructor(message, "SyntaxError");
  }
  const error = new Error(message);
  error.name = "SyntaxError";
  return error;
}

function marginText(input: unknown): string {
  try {
    return String(input ?? "0px").trim();
  } catch {
    throw syntaxError("invalid root margin");
  }
}

function marginParts(text: string): string[] {
  return text ? text.split(/\s+/) : ["0px"];
}

function parseMarginPart(part: string): Margin {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|cm|mm|q|in|pt|pc|%)$/i.exec(part);
  if (!match) throw syntaxError("invalid root margin");
  if (match[2] === "%") return { value: Number(match[1]), percent: true };
  const pixels = marginUnitPixels(match[2]);
  return { value: Math.floor(Number(match[1]) * pixels), percent: false };
}

function marginUnitPixels(unit: string): number {
  const CSS_PIXELS_PER_INCH = 96;
  const CSS_CENTIMETERS_PER_INCH = 2.54;
  const CSS_MILLIMETERS_PER_INCH = 25.4;
  const CSS_QUARTER_MILLIMETERS_PER_INCH = 101.6;
  const CSS_POINTS_PER_INCH = 72;
  const CSS_PIXELS_PER_PICA = 16;
  return {
    px: 1,
    cm: CSS_PIXELS_PER_INCH / CSS_CENTIMETERS_PER_INCH,
    mm: CSS_PIXELS_PER_INCH / CSS_MILLIMETERS_PER_INCH,
    q: CSS_PIXELS_PER_INCH / CSS_QUARTER_MILLIMETERS_PER_INCH,
    in: CSS_PIXELS_PER_INCH,
    pt: CSS_PIXELS_PER_INCH / CSS_POINTS_PER_INCH,
    pc: CSS_PIXELS_PER_PICA,
  }[unit.toLowerCase() as "px" | "cm" | "mm" | "q" | "in" | "pt" | "pc"];
}

function expandMargins(values: Margin[]): Margin[] {
  if (values.length === 1) return [values[0], values[0], values[0], values[0]];
  if (values.length === 2) return [values[0], values[1], values[0], values[1]];
  if (values.length === 3) return [values[0], values[1], values[2], values[1]];
  return values;
}

function parseMargins(input: unknown): Margin[] {
  const parts = marginParts(marginText(input));
  if (parts.length > MAX_ROOT_MARGIN_COMPONENTS) {
    throw syntaxError("invalid root margin");
  }
  return expandMargins(parts.map(parseMarginPart));
}

function serializeMargins(values: Margin[]): string {
  return values.map(({ value, percent }) => `${value}${percent ? "%" : "px"}`).join(" ");
}

function parseThresholds(value: unknown): number[] {
  let values: unknown[];
  if (Array.isArray(value)) {
    values = [...value];
  } else if (value === undefined) {
    values = [0];
  } else {
    values = [value];
  }
  if (values.length === 0) values.push(0);
  const thresholds = values.map((item) => {
    const number = Number(item);
    if (Number.isNaN(number)) throw new TypeError("threshold is not a number");
    if (number < 0 || number > 1) {
      throw new RangeError("threshold must be between 0 and 1");
    }
    return number;
  });
  return [...new Set(thresholds)].sort((left, right) => left - right);
}

function defineAttribute(
  prototype: object,
  name: string,
  slot: string,
  map: (value: any) => unknown = (value) => value,
): void {
  const getter = function (this: any): unknown {
    if (!this || !Object.prototype.hasOwnProperty.call(this, slot)) {
      throw new TypeError(`Illegal invocation of ${name}`);
    }
    return map(this[slot]);
  };
  try {
    Object.defineProperty(getter, "name", { configurable: true, value: `get ${name}` });
  } catch {}
  Object.defineProperty(prototype, name, {
    configurable: true,
    enumerable: true,
    get: getter,
  });
}

function entryFrom(data: EntryData): EntryData {
  const entry = Object.create(IntersectionObserverEntry.prototype);
  Object.defineProperties(entry, {
    _time: { value: data.time },
    _target: { value: data.target },
    _rootBounds: { value: data.rootBounds },
    _boundingClientRect: { value: data.boundingClientRect },
    _intersectionRect: { value: data.intersectionRect },
    _isIntersecting: { value: data.isIntersecting },
    _isVisible: { value: data.isVisible },
    _intersectionRatio: { value: data.intersectionRatio },
  });
  return entry;
}

export function IntersectionObserverEntry(this: any, init?: any): void {
  if (!(this instanceof IntersectionObserverEntry)) {
    throw new TypeError("Illegal constructor");
  }
  if (!init || typeof init !== "object") {
    throw new TypeError("IntersectionObserverEntry init is required");
  }
  const required = [
    "time",
    "rootBounds",
    "boundingClientRect",
    "intersectionRect",
    "isIntersecting",
    "isVisible",
    "intersectionRatio",
    "target",
  ];
  if (required.some((name) => !(name in init))) {
    throw new TypeError("IntersectionObserverEntry init is missing a required member");
  }
  Object.defineProperties(this, {
    _time: { value: Number(init.time) },
    _target: { value: init.target },
    _rootBounds: { value: init.rootBounds },
    _boundingClientRect: { value: init.boundingClientRect },
    _intersectionRect: { value: init.intersectionRect },
    _isIntersecting: { value: Boolean(init.isIntersecting) },
    _isVisible: { value: Boolean(init.isVisible) },
    _intersectionRatio: { value: Number(init.intersectionRatio) },
  });
}

defineAttribute(IntersectionObserverEntry.prototype, "time", "_time");
defineAttribute(IntersectionObserverEntry.prototype, "rootBounds", "_rootBounds");
defineAttribute(IntersectionObserverEntry.prototype, "boundingClientRect", "_boundingClientRect");
defineAttribute(IntersectionObserverEntry.prototype, "intersectionRect", "_intersectionRect");
defineAttribute(IntersectionObserverEntry.prototype, "isIntersecting", "_isIntersecting");
defineAttribute(IntersectionObserverEntry.prototype, "isVisible", "_isVisible");
defineAttribute(IntersectionObserverEntry.prototype, "intersectionRatio", "_intersectionRatio");
defineAttribute(IntersectionObserverEntry.prototype, "target", "_target");
Object.defineProperty(IntersectionObserverEntry.prototype, Symbol.toStringTag, {
  configurable: true,
  value: "IntersectionObserverEntry",
});
function reportCallbackError(win: any, thrown: unknown): void {
  pushException(thrown, {
    scriptId: "intersection-observer",
    url: "/__ks_intersection_observer.js",
    text: "Uncaught",
  });
  try {
    dispatchCallbackError(win, thrown, callbackErrorMessage(thrown));
  } catch {}
  try {
    console.error("[kitesurf] IntersectionObserver callback threw:", thrown);
  } catch {}
}

function isMessageBearingError(thrown: unknown): thrown is object & { message: unknown } {
  return thrown !== null && typeof thrown === "object" && "message" in thrown;
}

function callbackErrorMessage(thrown: unknown): string {
  if (!isMessageBearingError(thrown)) return `Uncaught ${String(thrown)}`;
  const name = "name" in thrown ? String(thrown.name) : "Error";
  return `Uncaught ${name}: ${String(thrown.message)}`;
}

function dispatchCallbackError(win: any, thrown: unknown, message: string): void {
  dispatchCallbackErrorEvent(win, thrown, message);
  notifyCallbackErrorHandler(win, thrown, message);
}

function dispatchCallbackErrorEvent(win: any, thrown: unknown, message: string): void {
  const ErrorEventConstructor = ksEventCtors.ErrorEvent || ksGlobal.ErrorEvent;
  if (typeof ErrorEventConstructor === "function") {
    win?.dispatchEvent?.(
      new ErrorEventConstructor("error", {
        message,
        error: thrown,
        cancelable: true,
        bubbles: false,
      }),
    );
  }
}

function notifyCallbackErrorHandler(win: any, thrown: unknown, message: string): void {
  const handler = callbackErrorHandler(win);
  if (handler) handler.call(win, message, "", 0, 0, thrown);
}

function callbackErrorHandler(win: any): ((...args: unknown[]) => unknown) | null {
  const winHandler = win && win.onerror;
  const globalHandler = ksGlobal.onerror;
  if (typeof winHandler === "function") return winHandler;
  if (typeof globalHandler === "function") return globalHandler;
  return null;
}

function assertObserver(value: unknown): asserts value is ObserverInstance {
  if (!value || !Object.prototype.hasOwnProperty.call(value, "_targets")) {
    throw new TypeError("Illegal invocation");
  }
}

function gateValue(win: any): string {
  const internal = getInternalState();
  return [
    internal.mutationSeq | 0,
    windowNumber(win, "scrollX"),
    windowNumber(win, "scrollY"),
    windowNumber(win, "innerWidth"),
    windowNumber(win, "innerHeight"),
  ].join("/");
}

function windowNumber(
  win: any,
  property: "scrollX" | "scrollY" | "innerWidth" | "innerHeight",
): number {
  return Number(win?.[property]) || 0;
}

function queueTask(callback: () => void): void {
  if (setTask) {
    setTask(callback, 0);
  } else {
    callback();
  }
}

function poll(resetGate = true): void {
  const schedule = setTask;
  if (!canPoll(schedule)) return;
  const tick = () => runPollTick(tick, schedule);
  if (resetGate) gate = gateValue(installedWindow);
  timer = schedule(tick, POLL_INTERVAL_MS);
}

function canPoll(schedule: typeof setTask): schedule is NonNullable<typeof setTask> {
  return timer === null && active.size > 0 && !!schedule;
}

function runPollTick(tick: () => void, schedule: NonNullable<typeof setTask>): void {
  timer = null;
  if (active.size === 0) return;
  recheckIntersectionObservers("poll");
  timer = schedule(tick, POLL_INTERVAL_MS);
}

function stopPolling(): void {
  if (active.size === 0 && timer !== null) {
    try {
      clearTask?.(timer);
    } catch {}
    timer = null;
  }
}

function rootBounds(observer: ObserverInstance, win: any): Rect | null {
  return observer._root && observer._root.nodeType === 1 ? rect(observer._root) : viewport(win);
}

function intersectionNow(): number {
  return Number(ksGlobal.performance?.now?.()) || Date.now();
}

function fallbackEntry(
  observer: ObserverInstance,
  target: any,
  win: any,
  resolve: boolean,
): EntryData | null {
  if (!resolve) return null;
  return {
    time: intersectionNow(),
    target,
    rootBounds: rootBounds(observer, win),
    boundingClientRect: zeroRect(),
    intersectionRect: zeroRect(),
    isIntersecting: false,
    isVisible: false,
    intersectionRatio: 0,
  };
}

function marginPairs(margins: Margin[]): Float32Array {
  return new Float32Array(margins.flatMap(({ value, percent }) => [value, percent ? 1 : 0]));
}

function canReadIntersectionGeometry(paint: any): boolean {
  return !!paint && typeof paint.intersectionGeometry === "function";
}

function readIntersectionGeometry(
  paint: any,
  observer: ObserverInstance,
  nodeId: number,
  resolve: boolean,
): IntersectionGeometry {
  return JSON.parse(
    paint.intersectionGeometry(
      nodeId,
      observer._rootId,
      marginPairs(observer._margins),
      marginPairs(observer._scrollMargins),
      state.scrollX,
      state.scrollY,
      resolve,
    ),
  );
}

function hasIntersectionGeometry(geometry: IntersectionGeometry): boolean {
  return !!geometry?.target && !!geometry.intersectionRect;
}

function isAboveObserverThreshold(
  observer: ObserverInstance,
  geometry: IntersectionGeometry,
  ratio: number,
): boolean {
  return Boolean(geometry.isIntersecting) && ratio >= (observer._thresholds[0] ?? 0);
}

function entryFromGeometry(
  observer: ObserverInstance,
  target: any,
  geometry: IntersectionGeometry,
): EntryData {
  const intersectionRatio = Number(geometry.intersectionRatio) || 0;
  return {
    time: intersectionNow(),
    target,
    rootBounds: geometry.rootBounds,
    boundingClientRect: geometry.target,
    intersectionRect: geometry.intersectionRect,
    isIntersecting: isAboveObserverThreshold(observer, geometry, intersectionRatio),
    isVisible: Boolean(geometry.isVisible),
    intersectionRatio,
  };
}

function entryFor(
  observer: ObserverInstance,
  target: any,
  win: any,
  resolve: boolean,
): EntryData | null {
  const nodeId = target?._id;
  if (typeof nodeId !== "number") return fallbackEntry(observer, target, win, resolve);
  return entryFromPaint(observer, target, win, resolve, nodeId, paintDomFor(resolve));
}

function paintDomFor(resolve: boolean): any {
  return resolve ? ensurePaintDom() : state.dom;
}

function entryFromPaint(
  observer: ObserverInstance,
  target: any,
  win: any,
  resolve: boolean,
  nodeId: number,
  paint: any,
): EntryData | null {
  if (!canReadIntersectionGeometry(paint)) return fallbackEntry(observer, target, win, resolve);
  try {
    const geometry = readIntersectionGeometry(paint, observer, nodeId, resolve);
    if (!hasIntersectionGeometry(geometry)) return fallbackEntry(observer, target, win, resolve);
    return entryFromGeometry(observer, target, geometry);
  } catch {
    invalidatePaintDom();
    return fallbackEntry(observer, target, win, resolve);
  }
}

function crossed(
  previous: ObserverRecord,
  current: EntryData,
  thresholds: readonly number[],
): boolean {
  if (previous == null) return true;
  if (previous.isIntersecting !== current.isIntersecting) return true;
  return thresholds.some(
    (threshold) =>
      (previous.intersectionRatio < threshold && current.intersectionRatio >= threshold) ||
      (previous.intersectionRatio >= threshold && current.intersectionRatio < threshold),
  );
}

export function runIntersectionObservers(resolve: boolean): void {
  if (active.size === 0) return;
  for (const observer of active) {
    observer._checkAll(resolve);
  }
}

export function recheckIntersectionObservers(kind: "frame" | "poll" | "layout"): void {
  if (active.size === 0) return;
  refreshFramePoll(kind);
  const next = gateValue(installedWindow);
  if (next === gate) return;
  if (canUseFreeLayoutCheck()) {
    recordFreeCheck(next);
    return;
  }
  if (kind === "layout") return;
  recordForcedCheck(next);
}

function refreshFramePoll(kind: "frame" | "poll" | "layout"): void {
  if (kind !== "frame" || timer === null) return;
  clearTask?.(timer);
  timer = null;
  poll(false);
}

function canUseFreeLayoutCheck(): boolean {
  return (
    state.dom?.layoutClean() === true &&
    state.paintCacheViewportW === state.paintViewportW &&
    state.paintCacheViewportH === state.paintViewportH
  );
}

function recordFreeCheck(next: string): void {
  gate = next;
  forcedBackoffMs = 0;
  stats.free++;
  runIntersectionObservers(false);
}

function forcedCheckIsTooSoon(now: number): boolean {
  return now - lastForcedAt < forcedBackoffMs;
}

function nextForcedBackoff(now: number): number {
  if (now - lastForcedAt >= MAX_FORCED_BACKOFF_MS * 2) return 0;
  return Math.min(MAX_FORCED_BACKOFF_MS, Math.max(FRAME_MS, forcedBackoffMs * 2));
}

function recordForcedCheck(next: string): void {
  const now = Date.now();
  if (forcedCheckIsTooSoon(now)) {
    stats.skipped++;
    return;
  }
  forcedBackoffMs = nextForcedBackoff(now);
  lastForcedAt = now;
  gate = next;
  stats.forced++;
  runIntersectionObservers(true);
}

function installScrollListener(win: any): void {
  if (installedWindow === win) return;
  installedWindow = win;
  try {
    win?.addEventListener?.("scroll", onScroll);
  } catch {}
}

function onScroll(): void {
  if (scrollTask !== null) return;
  scrollTask = true;
  queueTask(() => {
    scrollTask = null;
    gate = null;
    recheckIntersectionObservers("frame");
  });
}

function isElementRoot(rootValue: any): boolean {
  return rootValue.nodeType === 1 && typeof rootValue._id === "number";
}

function isDocumentRoot(rootValue: any): boolean {
  return rootValue.nodeType === 9;
}

function observerRoot(rootValue: any): { root: any; rootId: number } {
  let root = null;
  let rootId = -1;
  if (rootValue !== null && rootValue !== undefined) {
    if (isElementRoot(rootValue)) {
      root = rootValue;
      rootId = rootValue._id;
    } else if (isDocumentRoot(rootValue)) {
      root = rootValue;
    } else {
      throw new TypeError("root must be an Element or Document");
    }
  }
  return { root, rootId };
}

function observerDelay(init: any, trackVisibility: boolean): number {
  let delay = Math.trunc(Number(init.delay) || 0);
  if (trackVisibility && delay < MIN_VISIBILITY_DELAY_MS) delay = MIN_VISIBILITY_DELAY_MS;
  return delay;
}

function initializeObserver(observer: ObserverInstance, callback: unknown, options: any): void {
  const init = options == null ? {} : Object(options);
  const { root, rootId } = observerRoot(init.root);
  const margins = parseMargins(init.rootMargin);
  const scrollMargins = parseMargins(init.scrollMargin);
  const thresholdValues = Object.freeze(parseThresholds(init.threshold));
  const trackVisibility = Boolean(init.trackVisibility);
  const delay = observerDelay(init, trackVisibility);
  Object.defineProperties(observer, {
    _callback: { configurable: true, value: callback },
    _targets: { configurable: true, value: new Map() },
    _pending: { configurable: true, value: [], writable: true },
    _delivery: { configurable: true, value: null, writable: true },
    _margins: { configurable: true, value: margins },
    _scrollMargins: { configurable: true, value: scrollMargins },
    _root: { configurable: true, value: root },
    _rootId: { configurable: true, value: rootId },
    _thresholds: { configurable: true, value: thresholdValues },
    _delay: { configurable: true, value: delay },
    _trackVisibility: { configurable: true, value: trackVisibility },
  });
}

function isDetachedImplicitRoot(observer: ObserverInstance, target: any): boolean {
  return observer._root == null && target.ownerDocument?.defaultView == null;
}

function delayHasNotElapsed(
  observer: ObserverInstance,
  previous: ObserverRecord,
  current: EntryData,
): boolean {
  return Boolean(previous && observer._delay > 0 && current.time - previous.time < observer._delay);
}

function deliverObserverRecords(observer: ObserverInstance, win: any): void {
  observer._delivery = null;
  const records = observer.takeRecords();
  if (records.length === 0) return;
  try {
    observer._callback.call(observer, records, observer);
  } catch (error) {
    reportCallbackError(win, error);
  }
}

function enqueueObserverEntry(observer: ObserverInstance, current: EntryData, win: any): void {
  observer._pending.push(entryFrom(current));
  if (observer._delivery !== null) return;
  observer._delivery = true;
  queueTask(() => deliverObserverRecords(observer, win));
}

function updateObserverTarget(
  observer: ObserverInstance,
  target: any,
  previous: ObserverRecord,
  current: EntryData,
  win: any,
): void {
  if (delayHasNotElapsed(observer, previous, current)) return;
  observer._targets.set(target, current);
  if (crossed(previous, current, observer._thresholds)) {
    enqueueObserverEntry(observer, current, win);
  }
}

function checkObserverTarget(
  observer: ObserverInstance,
  target: any,
  resolve: boolean,
  win: any,
): void {
  if (!observer._targets.has(target)) return;
  const previous = observer._targets.get(target);
  if (isDetachedImplicitRoot(observer, target)) {
    observer._targets.set(target, null);
    return;
  }
  const current = entryFor(observer, target, win, resolve);
  if (current !== null) updateObserverTarget(observer, target, previous, current, win);
}

export function installIntersectionObserver(
  win: any,
  schedule: (callback: () => void, ms?: number) => unknown,
  cancel: (id: unknown) => void,
  defineEnumerableProto: (prototype: object, methods: Record<string, Function>) => void,
): void {
  setTask = schedule;
  clearTask = cancel;
  installScrollListener(win);
  if (typeof globalThis.IntersectionObserver === "function") return;

  const IntersectionObserverImpl = function (
    this: ObserverInstance,
    callback: unknown,
    options?: any,
  ): void {
    if (typeof callback !== "function") {
      throw new TypeError("IntersectionObserver callback must be a function");
    }
    if (!(this instanceof IntersectionObserverImpl)) {
      throw new TypeError("Illegal constructor");
    }
    initializeObserver(this, callback, options);
  } as any;

  defineAttribute(IntersectionObserverImpl.prototype, "root", "_root");
  defineAttribute(IntersectionObserverImpl.prototype, "rootMargin", "_margins", serializeMargins);
  defineAttribute(
    IntersectionObserverImpl.prototype,
    "scrollMargin",
    "_scrollMargins",
    serializeMargins,
  );
  defineAttribute(IntersectionObserverImpl.prototype, "thresholds", "_thresholds");
  defineAttribute(IntersectionObserverImpl.prototype, "delay", "_delay");
  defineAttribute(IntersectionObserverImpl.prototype, "trackVisibility", "_trackVisibility");
  Object.defineProperty(IntersectionObserverImpl.prototype, Symbol.toStringTag, {
    configurable: true,
    value: "IntersectionObserver",
  });

  defineEnumerableProto(IntersectionObserverImpl.prototype, {
    observe(this: ObserverInstance, target: any): void {
      assertObserver(this);
      if (!target || target.nodeType !== 1) {
        throw new TypeError("target must be an Element");
      }
      if (this._targets.has(target)) return;
      this._targets.set(target, undefined);
      active.add(this);
      gate = null;
      poll();
      queueTask(() => {
        if (this._targets.has(target)) this._check(target, true);
      });
    },
    unobserve(this: ObserverInstance, target: any): void {
      assertObserver(this);
      if (arguments.length === 0) {
        throw new TypeError("target must be an Element");
      }
      this._targets.delete(target);
      this._pending = this._pending.filter((entry) => entry.target !== target);
      if (this._targets.size === 0) {
        active.delete(this);
        stopPolling();
      }
    },
    disconnect(this: ObserverInstance): void {
      assertObserver(this);
      this._targets.clear();
      this._pending.length = 0;
      active.delete(this);
      stopPolling();
    },
    takeRecords(this: ObserverInstance): any[] {
      assertObserver(this);
      const records = this._pending;
      this._pending = [];
      return records;
    },
  });

  Object.defineProperties(IntersectionObserverImpl.prototype, {
    _check: {
      configurable: true,
      value: function (this: ObserverInstance, target: any, resolve: boolean): void {
        checkObserverTarget(this, target, resolve, win);
      },
    },
    _checkAll: {
      configurable: true,
      value: function (this: ObserverInstance, resolve: boolean): void {
        for (const [target, previous] of this._targets) {
          if (previous !== undefined) this._check(target, resolve);
        }
      },
    },
  });

  Object.defineProperty(IntersectionObserverImpl, "length", { value: 1 });
  Object.defineProperty(IntersectionObserverImpl, "name", {
    configurable: true,
    value: "IntersectionObserver",
  });
  Object.defineProperty(IntersectionObserverImpl, "prototype", { writable: false });
  Object.defineProperty(IntersectionObserverEntry, "prototype", { writable: false });
  const publish = (name: string, value: unknown): void => {
    const descriptor = {
      configurable: true,
      enumerable: false,
      writable: true,
      value,
    };
    if (win && win !== globalThis) {
      try {
        Object.defineProperty(win, name, descriptor);
      } catch {}
    }
    try {
      Object.defineProperty(globalThis, name, descriptor);
    } catch {
      ksGlobal[name] = value;
    }
  };
  publish("IntersectionObserverEntry", IntersectionObserverEntry);
  publish("IntersectionObserver", IntersectionObserverImpl);
}
