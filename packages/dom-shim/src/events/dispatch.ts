// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Handles listener registration, propagation, trusted dispatch, and listener exceptions.

import {
  ksGlobal,
  ksGlobalByKey,
  WINDOW_KEY,
  windowObj,
  windowProxy,
  documentImpl,
  dom,
  nodeFor,
  listenerRegistry,
} from "../state.js";
import type { ListenerEntry } from "../state.js";
import type * as Idl from "../idl/types.generated.js";
import { activationListenerIds, liveWrapper } from "../registries.js";
import { hostIdToDoc } from "../registries.js";
import { ksSpan, safeEventType } from "../otel.js";
import {
  KsErrorEvent,
  type KsEvent,
  type EventState,
  eventState,
  exposesRelatedTarget,
  isEventDefaultPrevented,
  isEventInPassiveListener,
  setEventCurrentTarget,
  setEventInPassiveListener,
  setEventTarget,
} from "./event.js";
import { noteListenerRemoved, noteListenerType } from "../transitions.js";
import { __ks_setEventTrusted, __ks_trustedFlags } from "../trust.js";
import { MAX_SHADOW_ROOT_HOPS } from "../constants.js";

let contentAttrHydrator: ((target: Idl.EventTarget, type: string) => void) | null = null;
const eventsInFlight = new WeakSet<object>();
const MAX_EVENT_PATH_HOPS = 1024;

let inErrorReportingMode = false;

interface DispatchMetadata {
  type: string;
  bubbles: boolean;
  cancelable: boolean;
  composed: boolean;
}

// A node id, WINDOW_KEY, or a non-node EventTarget itself.
type EventTargetKey = number | string | Idl.EventTarget;

interface PropagationEntry {
  key: EventTargetKey;
  target: EventTargetKey;
}

export function setContentAttrHydrator(fn: (target: Idl.EventTarget, type: string) => void): void {
  contentAttrHydrator = fn;
}

const objectListenerRegistry = new WeakMap<object, Map<string, ListenerEntry[]>>();

function isObjectKey(key: unknown): key is Idl.EventTarget {
  return typeof key === "object" && key !== null;
}

const nodeListenerRegistry = new WeakMap<object, Map<string, ListenerEntry[]>>();

// The events a mouse click fires at its target: a listener for one makes its element clickable
// in the accessibility tree, as Chrome's automation tree marks it.
export const ACTIVATION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "click",
  "mousedown",
  "mouseup",
  "pointerdown",
  "pointerup",
  "auxclick",
]);

function hasActivationListener(byType: Map<string, ListenerEntry[]>): boolean {
  for (const type of ACTIVATION_EVENT_TYPES) {
    if ((byType.get(type)?.length ?? 0) > 0) return true;
  }
  return false;
}

export function activationListenerNodeIds(): number[] {
  const ids: number[] = [];
  for (const id of activationListenerIds) {
    const wrapper = liveWrapper(id);
    const byType = wrapper ? nodeListenerRegistry.get(wrapper) : undefined;
    if (byType && hasActivationListener(byType)) ids.push(id);
    else activationListenerIds.delete(id);
  }
  return ids;
}

export function listenersFor(
  key: EventTargetKey,
  type: string,
  create: boolean,
): ListenerEntry[] | null {
  if (typeof key === "number") {
    const wrapper = liveWrapper(key) ?? (create ? nodeFor(key) : undefined);
    if (!wrapper) return null;
    return listenersIn(nodeListenerRegistry, wrapper, type, create);
  }
  if (isObjectKey(key)) return listenersIn(objectListenerRegistry, key, type, create);
  return listenersIn(listenerRegistry, key, type, create);
}

function listenersIn<K>(
  registry: {
    get(k: K): Map<string, ListenerEntry[]> | undefined;
    set(k: K, v: Map<string, ListenerEntry[]>): unknown;
  },
  key: K,
  type: string,
  create: boolean,
): ListenerEntry[] | null {
  let byType = registry.get(key);
  if (!byType) {
    if (!create) return null;
    byType = new Map();
    registry.set(key, byType);
  }
  let list = byType.get(type);
  if (!list) {
    if (!create) return null;
    list = [];
    byType.set(type, list);
  }
  return list;
}

export interface NormalizedListenerOptions {
  capture: boolean;
  once: boolean;
  passive: boolean;
}

export function normalizeListenerOptions(options: unknown): NormalizedListenerOptions {
  if (options === null || options === undefined) {
    return { capture: false, once: false, passive: false };
  }
  if (typeof options === "object" || typeof options === "function") {
    return {
      capture: !!Reflect.get(options, "capture"),
      once: !!Reflect.get(options, "once"),
      passive: !!Reflect.get(options, "passive"),
    };
  }
  return { capture: !!options, once: false, passive: false };
}

export function listenerOptionsHadPassive(options: unknown): boolean {
  return (
    options != null &&
    typeof options === "object" &&
    "passive" in options &&
    options.passive !== undefined
  );
}

export function addListener(
  key: EventTargetKey,
  type: unknown,
  listener: unknown,
  options: unknown,
): void {
  if (typeof type !== "string") return;
  const opts = normalizeListenerOptions(options);
  if (listener == null) return;
  if (typeof listener !== "function" && typeof listener !== "object") return;
  let passive = opts.passive;
  if (!listenerOptionsHadPassive(options)) {
    passive = defaultPassiveFor(key, type);
  }
  const list = listenersFor(key, type, true)!;
  for (const entry of list) {
    if (entry.listener === listener && entry.capture === opts.capture) return;
  }
  list.push({ listener, capture: opts.capture, once: opts.once, passive });
  if (typeof key === "number" && ACTIVATION_EVENT_TYPES.has(type)) activationListenerIds.add(key);
  noteListenerType(type);
}

export function defaultPassiveFor(key: EventTargetKey, type: string): boolean {
  if (type !== "touchstart" && type !== "touchmove" && type !== "wheel" && type !== "mousewheel") {
    return false;
  }
  if (key === WINDOW_KEY) return true;
  try {
    const doc = (windowObj && windowObj.document) || documentImpl;
    if (!doc) return false;
    if (key === doc._id) return true;
    const html = doc.documentElement;
    if (html && key === html._id) return true;
    const body = doc.body;
    if (body && key === body._id) return true;
  } catch {}
  return false;
}

export function removeListener(
  key: EventTargetKey,
  type: unknown,
  listener: unknown,
  options: unknown,
): void {
  if (typeof type !== "string") return;
  let capture = false;
  if (options !== null && options !== undefined) {
    if (typeof options === "object" || typeof options === "function") {
      capture = !!Reflect.get(options, "capture");
    } else {
      capture = !!options;
    }
  }
  const list = listenersFor(key, type, false);
  if (!list) return;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e.listener === listener && e.capture === capture) {
      list.splice(i, 1);
      noteListenerRemoved(type);
      return;
    }
  }
}

function flatParentId(nodeId: number): number {
  try {
    const slot = dom.assignedSlotOf(nodeId);
    if (slot >= 0) return slot;
  } catch {}
  try {
    const parent = dom.parentId(nodeId);
    return parent >= 0 && parent !== nodeId ? parent : -1;
  } catch {
    return -1;
  }
}

function retargetId(aId: number, bKey: EventTargetKey): number {
  let a = aId;
  let safety = 0;
  while (safety++ < MAX_SHADOW_ROOT_HOPS) {
    let rootA = -1;
    try {
      rootA = dom.shadowHostId(a) >= 0 ? a : dom.containingShadowRootId(a);
    } catch {}
    if (rootA < 0) return a;
    let contains = false;
    if (typeof bKey === "number") {
      let b = bKey;
      let s2 = 0;
      while (s2++ < MAX_SHADOW_ROOT_HOPS) {
        let rootB = -1;
        try {
          rootB = dom.shadowHostId(b) >= 0 ? b : dom.containingShadowRootId(b);
        } catch {}
        if (rootB < 0) break;
        if (rootB === rootA) {
          contains = true;
          break;
        }
        let host = -1;
        try {
          host = dom.shadowHostId(rootB);
        } catch {}
        if (host < 0) break;
        b = host;
      }
    }
    if (contains) return a;
    let host = -1;
    try {
      host = dom.shadowHostId(rootA);
    } catch {}
    if (host < 0) return a;
    a = host;
  }
  return a;
}

export function propagationPath(
  targetKey: EventTargetKey,
  composed?: boolean,
  eventType?: string,
): PropagationEntry[] {
  if (targetKey === WINDOW_KEY) return [{ key: WINDOW_KEY, target: WINDOW_KEY }];
  if (isObjectKey(targetKey)) return [{ key: targetKey, target: targetKey }];
  if (typeof targetKey !== "number") return [{ key: WINDOW_KEY, target: WINDOW_KEY }];

  let stopAtRoot = -1;
  if (composed === false) {
    try {
      stopAtRoot =
        dom.shadowHostId(targetKey) >= 0 ? targetKey : dom.containingShadowRootId(targetKey);
    } catch {}
  }

  const path: PropagationEntry[] = [];
  let cur = targetKey;
  let safety = 0;
  while (cur != null && cur >= 0 && safety < MAX_EVENT_PATH_HOPS) {
    path.push({ key: cur, target: retargetId(targetKey, cur) });
    if (cur === stopAtRoot) return path;
    cur = flatParentId(cur);
    safety++;
  }
  if (eventType !== "load") {
    path.push({ key: WINDOW_KEY, target: retargetId(targetKey, WINDOW_KEY) });
  }
  return path;
}

function setEventRelatedTarget(
  event: object & { relatedTarget?: unknown },
  value: Idl.EventTarget | null,
): void {
  if (exposesRelatedTarget(event)) eventState(event).relatedTarget = value;
  else event.relatedTarget = value;
}

function applyRetargeting(
  event: KsEvent,
  entry: PropagationEntry,
  targetKey: EventTargetKey,
  origRelatedId: number,
): boolean {
  setEventTarget(event, targetForKey(entry.target));
  if (origRelatedId >= 0) {
    const retargetedRelated = retargetId(origRelatedId, entry.key);
    setEventRelatedTarget(event, targetForKey(retargetedRelated));
    if (retargetedRelated === entry.target && origRelatedId !== targetKey) {
      return false;
    }
  }
  return true;
}

export function targetForKey(key: unknown): Idl.EventTarget | null {
  if (key === WINDOW_KEY) return windowProxy;
  if (isObjectKey(key)) return key;
  if (typeof key === "number") {
    const hostDoc = hostIdToDoc.get(key);
    if (hostDoc) return hostDoc;
    return nodeFor ? nodeFor(key) : null;
  }
  return null;
}

// The stack, else the message, of a thrown value, for the console.
function errorStackOrMessage(thrown: unknown): unknown {
  if (!thrown) return String(thrown);
  const stack: unknown = Reflect.get(Object(thrown), "stack");
  if (stack) return stack;
  const message: unknown = Reflect.get(Object(thrown), "message");
  return message ? message : String(thrown);
}

function isDispatchObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

export function reportException(thrown: unknown): void {
  if (inErrorReportingMode) return;
  inErrorReportingMode = true;
  try {
    const messageValue: unknown = thrown
      ? Reflect.get(Object(thrown), "message", thrown)
      : undefined;
    let message = "Uncaught " + String(thrown);
    if (messageValue) {
      if (typeof messageValue === "symbol") {
        throw new TypeError("Cannot convert a Symbol value to a string");
      }
      message = "Uncaught Error: " + String(messageValue);
    }
    const event = new KsErrorEvent("error", {
      message,
      error: thrown,
      cancelable: true,
      bubbles: false,
    });
    const windowValue: unknown = ksGlobal.window || globalThis;
    const win = isDispatchObject(windowValue) ? windowValue : globalThis;
    const dispatchEvent: unknown = Reflect.get(win, "dispatchEvent", win);
    if (typeof dispatchEvent === "function") {
      try {
        Reflect.apply(dispatchEvent, win, [event]);
      } catch {}
    }
    const winHandler: unknown = Reflect.get(win, "onerror", win) || null;
    const globalHandler: unknown = ksGlobal.onerror || null;
    const handler =
      typeof winHandler === "function"
        ? winHandler
        : typeof globalHandler === "function"
          ? globalHandler
          : null;
    if (handler) {
      try {
        Reflect.apply(handler, win, [message, "", 0, 0, thrown]);
      } catch {}
    }
  } catch {
  } finally {
    inErrorReportingMode = false;
  }
}

export function dispatchOnKey(
  targetKey: EventTargetKey | (() => EventTargetKey),
  event: unknown,
): boolean {
  return dispatchLocked(
    event,
    false,
    typeof targetKey === "function" ? targetKey : () => targetKey,
  );
}

export function dispatchTrustedOnKey(targetKey: EventTargetKey, event: unknown): boolean {
  return dispatchLocked(event, true, () => targetKey);
}

/**
 * Dispatches a trusted event to Window or its canonical node wrapper.
 * Invalid node targets throw `TypeError`.
 */
export function dispatchTrustedEvent(target: object | null, event: unknown): boolean {
  return dispatchLocked(event, true, () => {
    if (target === windowProxy) return WINDOW_KEY;
    // Only the canonical wrapper may dispatch a trusted event for a node ID.
    const candidates: unknown[] = target
      ? [Reflect.get(target, "_id"), Reflect.get(target, "_hostId")]
      : [];
    for (const key of candidates) {
      if (typeof key === "number" && targetForKey(key) === target) return key;
    }
    throw new TypeError("Invalid trusted event target");
  });
}

// Every event the shim constructs registers its trust flag, so the flag
// marks a KsEvent.
function assertEvent(event: unknown): asserts event is KsEvent {
  if (!isDispatchObject(event) || !__ks_trustedFlags.has(event)) {
    throw new TypeError("dispatchEvent: argument must be an Event");
  }
}

function snapshotDispatchMetadata(state: EventState): DispatchMetadata {
  // Freeze propagation flags at dispatch start; listeners cannot change a path already in flight.
  return {
    type: state.type,
    bubbles: state.bubbles,
    cancelable: state.cancelable,
    composed: state.composed,
  };
}

// Lock before reading page-owned properties: their getters can try to redispatch the event.
// Always restore dispatch state so a thrown getter cannot leave the event locked.
// Dispatch flags: https://dom.spec.whatwg.org/#concept-event-dispatch
function dispatchLocked(
  event: unknown,
  trusted: boolean,
  resolveTargetKey: () => EventTargetKey,
): boolean {
  assertEvent(event);
  const state = eventState(event);
  if (eventsInFlight.has(event)) {
    throw new DOMException("Event is already being dispatched", "InvalidStateError");
  }
  eventsInFlight.add(event);
  let targetKey: EventTargetKey | undefined;
  let origRelated: unknown;
  let origRelatedId = -1;
  let relatedCaptured = false;
  let prevGlobalEvent: unknown;
  let prevWindowEvent: unknown;
  try {
    prevGlobalEvent = ksGlobal.event;
  } catch {}
  if (windowObj) {
    try {
      prevWindowEvent = "event" in windowObj ? windowObj.event : undefined;
    } catch {}
  }
  try {
    if (!state.initialized) {
      throw new DOMException("Event is uninitialized", "InvalidStateError");
    }
    targetKey = resolveTargetKey();
    const metadata = snapshotDispatchMetadata(state);
    __ks_setEventTrusted(event, trusted);
    origRelated = Reflect.get(event, "relatedTarget");
    relatedCaptured = true;
    const relatedId: unknown = isDispatchObject(origRelated)
      ? Reflect.get(origRelated, "_id")
      : undefined;
    origRelatedId = typeof relatedId === "number" ? relatedId : -1;
    const key = targetKey;
    return ksSpan("dom.dispatchEvent", { event_type: safeEventType(metadata.type) }, () =>
      dispatchOnKeyInnerUnsafe(key, event, state, metadata, origRelatedId),
    );
  } finally {
    state.currentTarget = null;
    state.eventPhase = 0;
    state.stopPropagation = false;
    state.stopImmediatePropagation = false;
    state.path = null;
    state.inPassiveListener = false;
    if (targetKey !== undefined) {
      try {
        setEventTarget(event, targetForKey(targetKey));
      } catch {}
    }
    if (relatedCaptured) {
      // Put back the value read before dispatch. Page code can store
      // anything in relatedTarget; dispatch never checks it.
      try {
        setEventRelatedTarget(event, origRelated as Idl.EventTarget | null);
      } catch {}
    }
    try {
      ksGlobal.event = prevGlobalEvent;
    } catch {}
    if (windowObj) {
      try {
        windowObj.event = prevWindowEvent;
      } catch {}
    }
    eventsInFlight.delete(event);
  }
}

function dispatchOnKeyInnerUnsafe(
  targetKey: EventTargetKey,
  event: KsEvent,
  state: EventState,
  metadata: DispatchMetadata,
  origRelatedId: number,
): boolean {
  try {
    const handlerName = "on" + metadata.type;
    const bare = ksGlobalByKey[handlerName];
    if (typeof bare === "function" && windowProxy && windowProxy[handlerName] == null) {
      windowProxy[handlerName] = bare;
    }
  } catch {}
  state.dispatched = true;
  setEventTarget(event, targetForKey(targetKey));
  try {
    ksGlobal.event = event;
  } catch {}
  if (windowObj) {
    try {
      windowObj.event = event;
    } catch {}
  }
  const path = propagationPath(targetKey, metadata.composed, metadata.type);
  if (contentAttrHydrator) {
    for (const entry of path) {
      const t = targetForKey(entry.key);
      if (t) {
        try {
          contentAttrHydrator(t, metadata.type);
        } catch {}
      }
    }
  }
  state.path = path
    .map((entry) => targetForKey(entry.key))
    .filter((target): target is Idl.EventTarget => target != null);

  state.eventPhase = 1;
  for (let i = path.length - 1; i > 0; i--) {
    if (state.stopPropagation) break;
    const entry = path[i];
    const list = listenersFor(entry.key, metadata.type, false);
    if (!list || list.length === 0) continue;
    if (!applyRetargeting(event, entry, targetKey, origRelatedId)) continue;
    setEventCurrentTarget(event, targetForKey(entry.key));
    invokeListeners(list, event, true);
  }

  if (!state.stopPropagation) {
    state.eventPhase = 2;
    const list = listenersFor(targetKey, metadata.type, false);
    if (list && list.length > 0 && applyRetargeting(event, path[0], targetKey, origRelatedId)) {
      setEventCurrentTarget(event, targetForKey(targetKey));
      invokeListeners(list, event, true);
      if (!state.stopImmediatePropagation && !state.stopPropagation) {
        invokeListeners(list, event, false);
      }
    }
  }

  if (!state.stopPropagation && metadata.bubbles) {
    state.eventPhase = 3;
    for (let i = 1; i < path.length; i++) {
      if (state.stopPropagation) break;
      const entry = path[i];
      const list = listenersFor(entry.key, metadata.type, false);
      if (!list || list.length === 0) continue;
      if (!applyRetargeting(event, entry, targetKey, origRelatedId)) continue;
      setEventCurrentTarget(event, targetForKey(entry.key));
      invokeListeners(list, event, false);
    }
  }

  return !(metadata.cancelable && isEventDefaultPrevented(event));
}

function invokeListenerCallback(listener: ListenerEntry["listener"], event: KsEvent): void {
  if (typeof listener === "function") {
    listener.call(event.currentTarget, event);
    return;
  }
  if (!listener) return;
  const handleEvent = listener.handleEvent;
  if (typeof handleEvent === "function") handleEvent.call(listener, event);
  else if (handleEvent !== undefined) {
    throw new TypeError("Failed to invoke EventListener: handleEvent is not a function");
  }
}

export function invokeListeners(
  list: ListenerEntry[],
  event: KsEvent,
  captureOnly: boolean | null,
): void {
  // Listener changes do not alter this pass, but removed entries are skipped.
  const snapshot = list.slice();
  const state = eventState(event);
  for (const entry of snapshot) {
    if (state.stopImmediatePropagation) return;
    if (captureOnly !== null && captureOnly !== entry.capture) continue;
    if (list.indexOf(entry) < 0) continue;
    // Remove once-listeners before page code so reentrant dispatch cannot invoke them again.
    if (entry.once) {
      const idx = list.indexOf(entry);
      if (idx >= 0) {
        list.splice(idx, 1);
        noteListenerRemoved(event.type);
      }
    }
    let thrown: unknown = null;
    let threw = false;
    const prevPassive = isEventInPassiveListener(event);
    setEventInPassiveListener(event, !!entry.passive);
    try {
      invokeListenerCallback(entry.listener, event);
    } catch (err) {
      thrown = err;
      threw = true;
    }
    if (threw) {
      reportException(thrown);
      try {
        console.error(
          "[kitesurf] event listener for",
          event.type,
          "threw:",
          errorStackOrMessage(thrown),
        );
      } catch {}
    }
    setEventInPassiveListener(event, prevPassive);
  }
}
