// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Handles listener registration, propagation, trusted dispatch, and listener exceptions.

import {
  ksGlobal,
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
import { liveWrapper } from "../registries.js";
import { hostIdToDoc } from "../registries.js";
import { ksSpan, safeEventType } from "../otel.js";
import {
  KsErrorEvent,
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

let contentAttrHydrator: ((target: any, type: string) => void) | null = null;
const eventsInFlight = new WeakSet<object>();
const MAX_EVENT_PATH_HOPS = 1024;

let inErrorReportingMode = false;

interface DispatchMetadata {
  type: string;
  bubbles: boolean;
  cancelable: boolean;
  composed: boolean;
}

type EventTargetKey = number | string | object;

interface PropagationEntry {
  key: EventTargetKey;
  target: EventTargetKey;
}

export function setContentAttrHydrator(fn: (target: any, type: string) => void): void {
  contentAttrHydrator = fn;
}

const objectListenerRegistry = new WeakMap<object, Map<string, ListenerEntry[]>>();

function isObjectKey(key: unknown): key is Idl.EventTarget {
  return typeof key === "object" && key !== null;
}

const nodeListenerRegistry = new WeakMap<object, Map<string, ListenerEntry[]>>();

export function listenersFor(key: any, type: string, create: boolean): ListenerEntry[] | null {
  if (typeof key === "number") {
    return listenersForNode(key, type, create);
  }
  return listenersIn(registryForKey(key), key, type, create);
}

function listenersForNode(key: number, type: string, create: boolean): ListenerEntry[] | null {
  const wrapper = liveWrapper(key) ?? (create ? nodeFor(key) : undefined);
  if (!wrapper) return null;
  return listenersIn(nodeListenerRegistry, wrapper, type, create);
}

function registryForKey(key: any) {
  return isObjectKey(key) ? objectListenerRegistry : listenerRegistry;
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
      capture: !!(options as any).capture,
      once: !!(options as any).once,
      passive: !!(options as any).passive,
    };
  }
  return { capture: !!options, once: false, passive: false };
}

export function listenerOptionsHadPassive(options: unknown): boolean {
  return (
    options != null &&
    typeof options === "object" &&
    "passive" in (options as any) &&
    (options as any).passive !== undefined
  );
}

export function addListener(key: any, type: string, listener: any, options: unknown): void {
  if (typeof type !== "string") return;
  const opts = normalizeListenerOptions(options);
  if (!isListener(listener)) return;
  const passive = passiveForListener(key, type, options, opts.passive);
  const list = listenersFor(key, type, true)!;
  if (hasListener(list, listener, opts.capture)) return;
  list.push({ listener, capture: opts.capture, once: opts.once, passive });
  noteListenerType(type);
}

function isListener(listener: any): boolean {
  return listener != null && (typeof listener === "function" || typeof listener === "object");
}

function passiveForListener(key: any, type: string, options: unknown, passive: boolean): boolean {
  return listenerOptionsHadPassive(options) ? passive : defaultPassiveFor(key, type);
}

function hasListener(list: ListenerEntry[], listener: any, capture: boolean): boolean {
  for (const entry of list) {
    if (entry.listener === listener && entry.capture === capture) return true;
  }
  return false;
}

export function defaultPassiveFor(key: any, type: string): boolean {
  if (!isDefaultPassiveEventType(type)) return false;
  if (key === WINDOW_KEY) return true;
  try {
    const doc: any = defaultPassiveDocument();
    return isDefaultPassiveDocumentTarget(doc, key);
  } catch {
    return false;
  }
}

function defaultPassiveDocument() {
  return (windowObj && (windowObj as any).document) || documentImpl;
}

function isDefaultPassiveEventType(type: string): boolean {
  return type === "touchstart" || type === "touchmove" || type === "wheel" || type === "mousewheel";
}

function isDefaultPassiveDocumentTarget(doc: any, key: any): boolean {
  if (!doc) return false;
  if (key === doc._id) return true;
  return (
    isDefaultPassiveElementTarget(doc.documentElement, key) ||
    isDefaultPassiveElementTarget(doc.body, key)
  );
}

function isDefaultPassiveElementTarget(element: any, key: any): boolean {
  return !!element && key === element._id;
}

export function removeListener(key: any, type: string, listener: any, options: unknown): void {
  if (typeof type !== "string") return;
  const capture = captureForRemoveOptions(options);
  const list = listenersFor(key, type, false);
  if (!list) return;
  removeMatchingListener(list, type, listener, capture);
}

function captureForRemoveOptions(options: unknown): boolean {
  if (options === null || options === undefined) return false;
  if (typeof options === "object" || typeof options === "function") {
    return !!(options as any).capture;
  }
  return !!options;
}

function removeMatchingListener(
  list: ListenerEntry[],
  type: string,
  listener: any,
  capture: boolean,
): void {
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (entry.listener === listener && entry.capture === capture) {
      list.splice(i, 1);
      noteListenerRemoved(type);
      return;
    }
  }
}

function flatParentId(nodeId: number): number {
  const slot = assignedSlotId(nodeId);
  if (slot >= 0) return slot;
  return parentId(nodeId);
}

function assignedSlotId(nodeId: number): number {
  try {
    return (dom as any).assignedSlotOf(nodeId);
  } catch {
    return -1;
  }
}

function parentId(nodeId: number): number {
  try {
    const parent = (dom as any).parentId(nodeId);
    return parent >= 0 && parent !== nodeId ? parent : -1;
  } catch {
    return -1;
  }
}

function retargetId(aId: number, bKey: any): number {
  let a = aId;
  for (let safety = 0; safety < MAX_SHADOW_ROOT_HOPS; safety++) {
    const rootA = shadowRootFor(a);
    if (rootA < 0) return a;
    if (containsShadowRoot(bKey, rootA)) return a;
    const host = shadowHostId(rootA);
    if (host < 0) return a;
    a = host;
  }
  return a;
}

function shadowRootFor(nodeId: number): number {
  try {
    return (dom as any).shadowHostId(nodeId) >= 0
      ? nodeId
      : (dom as any).containingShadowRootId(nodeId);
  } catch {
    return -1;
  }
}

function containsShadowRoot(key: any, rootId: number): boolean {
  if (typeof key !== "number") return false;
  return hasShadowRootOnPath(key, rootId);
}

function hasShadowRootOnPath(startNodeId: number, rootId: number): boolean {
  let nodeId = startNodeId;
  for (let safety = 0; safety < MAX_SHADOW_ROOT_HOPS; safety++) {
    const root = shadowRootFor(nodeId);
    if (root < 0) break;
    if (root === rootId) return true;
    const host = shadowHostId(root);
    if (host < 0) break;
    nodeId = host;
  }
  return false;
}

function shadowHostId(nodeId: number): number {
  try {
    return (dom as any).shadowHostId(nodeId);
  } catch {
    return -1;
  }
}

export function propagationPath(
  targetKey: any,
  composed?: boolean,
  eventType?: string,
): PropagationEntry[] {
  const initial = initialPropagationPath(targetKey);
  if (initial) return initial;
  const stopAtRoot = stopAtShadowRoot(targetKey, composed);
  const path = collectNodePath(targetKey, stopAtRoot);
  if (eventType !== "load") appendWindowEntry(path, targetKey);
  return path;
}

function initialPropagationPath(targetKey: any): PropagationEntry[] | null {
  if (targetKey === WINDOW_KEY) return [{ key: WINDOW_KEY, target: WINDOW_KEY }];
  if (isObjectKey(targetKey)) return [{ key: targetKey, target: targetKey }];
  if (typeof targetKey !== "number") return [{ key: WINDOW_KEY, target: WINDOW_KEY }];
  return null;
}

function stopAtShadowRoot(targetKey: number, composed: boolean | undefined): number {
  if (composed !== false) return -1;
  return shadowRootFor(targetKey);
}

function collectNodePath(targetKey: number, stopAtRoot: number): PropagationEntry[] {
  const path: PropagationEntry[] = [];
  let cur = targetKey;
  let safety = 0;
  while (cur != null && cur >= 0 && safety < MAX_EVENT_PATH_HOPS) {
    path.push({ key: cur, target: retargetId(targetKey, cur) });
    if (cur === stopAtRoot) return path;
    cur = flatParentId(cur);
    safety++;
  }
  return path;
}

function appendWindowEntry(path: PropagationEntry[], targetKey: number): void {
  path.push({ key: WINDOW_KEY, target: retargetId(targetKey, WINDOW_KEY) });
}

function setEventRelatedTarget(
  event: object & { relatedTarget?: unknown },
  value: Idl.EventTarget | null,
): void {
  if (exposesRelatedTarget(event)) eventState(event).relatedTarget = value;
  else event.relatedTarget = value;
}

function applyRetargeting(
  event: any,
  entry: PropagationEntry,
  targetKey: any,
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
  if (typeof key === "number") return targetForNodeId(key);
  return null;
}

function targetForNodeId(key: number): Idl.EventTarget | null {
  const hostDoc = hostIdToDoc.get(key);
  if (hostDoc) return hostDoc;
  return nodeFor ? nodeFor(key) : null;
}

function isDispatchObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

export function reportException(thrown: unknown): void {
  if (inErrorReportingMode) return;
  inErrorReportingMode = true;
  try {
    const message = exceptionMessage(thrown);
    const event = new KsErrorEvent("error", {
      message,
      error: thrown,
      cancelable: true,
      bubbles: false,
    });
    const win = currentWindowForErrorReporting();
    dispatchErrorEvent(win, event);
    invokeErrorHandler(win, message, thrown);
  } catch {
  } finally {
    inErrorReportingMode = false;
  }
}

function exceptionMessage(thrown: unknown): string {
  const messageValue: unknown = thrown ? Reflect.get(Object(thrown), "message", thrown) : undefined;
  if (!messageValue) return "Uncaught " + String(thrown);
  if (typeof messageValue === "symbol") {
    throw new TypeError("Cannot convert a Symbol value to a string");
  }
  return "Uncaught Error: " + String(messageValue);
}

function dispatchErrorEvent(win: object, event: KsErrorEvent): void {
  const dispatchEvent: unknown = Reflect.get(win, "dispatchEvent", win);
  if (typeof dispatchEvent !== "function") return;
  try {
    Reflect.apply(dispatchEvent, win, [event]);
  } catch {}
}

function currentWindowForErrorReporting(): object {
  const windowValue: unknown = ksGlobal.window || globalThis;
  return isDispatchObject(windowValue) ? windowValue : globalThis;
}

function invokeErrorHandler(win: object, message: string, thrown: unknown): void {
  const winHandler: unknown = Reflect.get(win, "onerror", win) || null;
  const globalHandler: unknown = ksGlobal.onerror || null;
  const handler = selectErrorHandler(winHandler, globalHandler);
  if (!handler) return;
  try {
    Reflect.apply(handler, win, [message, "", 0, 0, thrown]);
  } catch {}
}

function selectErrorHandler(winHandler: unknown, globalHandler: unknown): Function | null {
  if (typeof winHandler === "function") return winHandler;
  if (typeof globalHandler === "function") return globalHandler;
  return null;
}

export function dispatchOnKey(targetKey: any, event: any): boolean {
  return dispatchLocked(
    event,
    false,
    typeof targetKey === "function" ? targetKey : () => targetKey,
  );
}

export function dispatchTrustedOnKey(targetKey: any, event: any): boolean {
  return dispatchLocked(event, true, () => targetKey);
}

/**
 * Dispatches a trusted event to Window or its canonical node wrapper.
 * Invalid node targets throw `TypeError`.
 */
export function dispatchTrustedEvent(target: any, event: any): boolean {
  return dispatchLocked(event, true, () => resolveTrustedTargetKey(target));
}

function resolveTrustedTargetKey(target: any): any {
  if (target === windowProxy) return WINDOW_KEY;
  // Only the canonical wrapper may dispatch a trusted event for a node ID.
  const candidates = trustedTargetCandidates(target);
  for (const key of candidates) {
    if (targetForKey(key) === target) return key;
  }
  throw new TypeError("Invalid trusted event target");
}

function trustedTargetCandidates(target: any): unknown[] {
  return [target?._id, target?._hostId];
}

function assertEvent(event: any): void {
  if (!event || !__ks_trustedFlags.has(event)) {
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
function dispatchLocked(event: any, trusted: boolean, resolveTargetKey: () => any): boolean {
  assertEvent(event);
  const state = eventState(event);
  if (eventsInFlight.has(event)) {
    throw new DOMException("Event is already being dispatched", "InvalidStateError");
  }
  eventsInFlight.add(event);
  try {
    return dispatchEventWithRestore(event, state, trusted, resolveTargetKey);
  } finally {
    eventsInFlight.delete(event);
  }
}

interface DispatchRestoreState {
  targetKey?: unknown;
  origRelated?: any;
  relatedCaptured: boolean;
}

interface PreviousDispatchGlobals {
  globalEvent: unknown;
  windowEvent: unknown;
}

function dispatchEventWithRestore(
  event: any,
  state: EventState,
  trusted: boolean,
  resolveTargetKey: () => any,
): boolean {
  const previousGlobals = captureDispatchGlobals();
  const restore: DispatchRestoreState = { relatedCaptured: false };
  try {
    return dispatchEventBody(event, state, trusted, resolveTargetKey, restore);
  } finally {
    resetEventDispatchState(state);
    restoreEventTargets(event, restore);
    restoreDispatchGlobals(previousGlobals);
  }
}

function captureDispatchGlobals(): PreviousDispatchGlobals {
  return {
    globalEvent: readGlobalEvent(),
    windowEvent: readWindowEvent(),
  };
}

function readGlobalEvent(): unknown {
  try {
    return ksGlobal.event;
  } catch {
    return undefined;
  }
}

function readWindowEvent(): unknown {
  if (!windowObj) return undefined;
  try {
    return "event" in (windowObj as any) ? (windowObj as any).event : undefined;
  } catch {
    return undefined;
  }
}

function dispatchEventBody(
  event: any,
  state: EventState,
  trusted: boolean,
  resolveTargetKey: () => any,
  restore: DispatchRestoreState,
): boolean {
  if (!state.initialized) {
    throw new DOMException("Event is uninitialized", "InvalidStateError");
  }
  restore.targetKey = resolveTargetKey();
  const metadata = snapshotDispatchMetadata(state);
  __ks_setEventTrusted(event, trusted);
  restore.origRelated = (event as any).relatedTarget;
  restore.relatedCaptured = true;
  const origRelatedId =
    restore.origRelated && typeof restore.origRelated._id === "number"
      ? restore.origRelated._id
      : -1;
  return ksSpan("dom.dispatchEvent", { event_type: safeEventType(metadata.type) }, () =>
    dispatchOnKeyInnerUnsafe(
      restore.targetKey,
      event,
      state,
      metadata,
      restore.origRelated,
      origRelatedId,
    ),
  );
}

function resetEventDispatchState(state: EventState): void {
  state.currentTarget = null;
  state.eventPhase = 0;
  state.stopPropagation = false;
  state.stopImmediatePropagation = false;
  state.path = null;
  state.inPassiveListener = false;
}

function restoreEventTargets(event: any, restore: DispatchRestoreState): void {
  if (restore.targetKey !== undefined) restoreEventTarget(event, restore.targetKey);
  if (restore.relatedCaptured) restoreEventRelatedTarget(event, restore.origRelated);
}

function restoreEventTarget(event: any, targetKey: unknown): void {
  try {
    setEventTarget(event, targetForKey(targetKey));
  } catch {}
}

function restoreEventRelatedTarget(event: any, relatedTarget: any): void {
  try {
    setEventRelatedTarget(event, relatedTarget);
  } catch {}
}

function restoreDispatchGlobals(previous: PreviousDispatchGlobals): void {
  restoreGlobalEvent(previous.globalEvent);
  restoreWindowEvent(previous.windowEvent);
}

function restoreGlobalEvent(value: unknown): void {
  try {
    ksGlobal.event = value;
  } catch {}
}

function restoreWindowEvent(value: unknown): void {
  if (!windowObj) return;
  try {
    (windowObj as any).event = value;
  } catch {}
}

function dispatchOnKeyInnerUnsafe(
  targetKey: any,
  event: any,
  state: EventState,
  metadata: DispatchMetadata,
  origRelated: any,
  origRelatedId: number,
): boolean {
  exposeLegacyEventHandler(metadata.type);
  state.dispatched = true;
  setEventTarget(event, targetForKey(targetKey));
  exposeEventGlobally(event);
  const path = propagationPath(targetKey, metadata.composed, metadata.type);
  hydrateContentAttributes(path, metadata.type);
  state.path = path
    .map((entry) => targetForKey(entry.key))
    .filter((target): target is Idl.EventTarget => target != null);

  dispatchCapturePhase(path, event, state, targetKey, metadata, origRelatedId);
  dispatchAtTarget(path, event, state, targetKey, metadata, origRelatedId);
  dispatchBubblePhase(path, event, state, targetKey, metadata, origRelatedId);

  return !(metadata.cancelable && isEventDefaultPrevented(event));
}

function exposeLegacyEventHandler(type: string): void {
  try {
    const handlerName = "on" + type;
    const bare = ksGlobal[handlerName];
    if (typeof bare === "function" && windowProxy && windowProxy[handlerName] == null) {
      windowProxy[handlerName] = bare;
    }
  } catch {}
}

function exposeEventGlobally(event: any): void {
  try {
    ksGlobal.event = event;
  } catch {}
  if (windowObj) {
    try {
      (windowObj as any).event = event;
    } catch {}
  }
}

function hydrateContentAttributes(path: PropagationEntry[], type: string): void {
  if (contentAttrHydrator) {
    for (const entry of path) {
      const t = targetForKey(entry.key);
      if (t) {
        try {
          contentAttrHydrator(t, type);
        } catch {}
      }
    }
  }
}

function dispatchCapturePhase(
  path: PropagationEntry[],
  event: any,
  state: EventState,
  targetKey: any,
  metadata: DispatchMetadata,
  origRelatedId: number,
): void {
  state.eventPhase = 1;
  for (let i = path.length - 1; i > 0; i--) {
    if (state.stopPropagation) break;
    const entry = path[i];
    const list = listenersFor(entry.key, metadata.type, false);
    if (!hasListeners(list)) continue;
    if (!applyRetargeting(event, entry, targetKey, origRelatedId)) continue;
    setEventCurrentTarget(event, targetForKey(entry.key));
    invokeListeners(list, event, true);
  }
}

function dispatchAtTarget(
  path: PropagationEntry[],
  event: any,
  state: EventState,
  targetKey: any,
  metadata: DispatchMetadata,
  origRelatedId: number,
): void {
  if (state.stopPropagation) return;
  state.eventPhase = 2;
  const list = listenersFor(targetKey, metadata.type, false);
  if (!canDispatchPathEntry(list, event, path[0], targetKey, origRelatedId)) return;
  setEventCurrentTarget(event, targetForKey(targetKey));
  invokeListeners(list, event, true);
  if (!state.stopImmediatePropagation && !state.stopPropagation) {
    invokeListeners(list, event, false);
  }
}

function dispatchBubblePhase(
  path: PropagationEntry[],
  event: any,
  state: EventState,
  targetKey: any,
  metadata: DispatchMetadata,
  origRelatedId: number,
): void {
  if (!shouldBubble(state, metadata)) return;
  state.eventPhase = 3;
  for (let i = 1; i < path.length; i++) {
    if (state.stopPropagation) break;
    const entry = path[i];
    const list = listenersFor(entry.key, metadata.type, false);
    if (!canDispatchPathEntry(list, event, entry, targetKey, origRelatedId)) continue;
    setEventCurrentTarget(event, targetForKey(entry.key));
    invokeListeners(list, event, false);
  }
}

function canDispatchPathEntry(
  list: ListenerEntry[] | null,
  event: any,
  entry: PropagationEntry,
  targetKey: any,
  origRelatedId: number,
): list is ListenerEntry[] {
  return hasListeners(list) && applyRetargeting(event, entry, targetKey, origRelatedId);
}

function hasListeners(list: ListenerEntry[] | null): list is ListenerEntry[] {
  return !!list && list.length > 0;
}

function shouldBubble(state: EventState, metadata: DispatchMetadata): boolean {
  return !state.stopPropagation && metadata.bubbles;
}

function invokeListenerCallback(listener: ListenerEntry["listener"], event: any) {
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
  event: any,
  captureOnly: boolean | null,
): void {
  // Listener changes do not alter this pass, but removed entries are skipped.
  const snapshot = list.slice();
  const state = eventState(event);
  for (const entry of snapshot) {
    if (state.stopImmediatePropagation) return;
    if (!matchesCapture(entry, captureOnly)) continue;
    if (list.indexOf(entry) < 0) continue;
    removeOnceListener(list, event, entry);
    invokeListenerSafely(entry, event);
  }
}

function matchesCapture(entry: ListenerEntry, captureOnly: boolean | null): boolean {
  return captureOnly === null || captureOnly === entry.capture;
}

function removeOnceListener(list: ListenerEntry[], event: any, entry: ListenerEntry): void {
  if (!entry.once) return;
  const idx = list.indexOf(entry);
  if (idx >= 0) {
    list.splice(idx, 1);
    noteListenerRemoved(event.type);
  }
}

function invokeListenerSafely(entry: ListenerEntry, event: any): void {
  const prevPassive = isEventInPassiveListener(event);
  setEventInPassiveListener(event, !!entry.passive);
  let thrown: any = null;
  let threw = false;
  try {
    invokeListenerCallback(entry.listener, event);
  } catch (err) {
    thrown = err;
    threw = true;
  }
  if (threw) {
    reportException(thrown);
    logListenerException(event, thrown);
  }
  setEventInPassiveListener(event, prevPassive);
}

function logListenerException(event: any, thrown: any): void {
  try {
    console.error(
      "[kitesurf] event listener for",
      event.type,
      "threw:",
      listenerExceptionDetails(thrown),
    );
  } catch {}
}

function listenerExceptionDetails(thrown: any): string {
  if (thrown && thrown.stack) return thrown.stack;
  if (thrown && thrown.message) return thrown.message;
  return String(thrown);
}
