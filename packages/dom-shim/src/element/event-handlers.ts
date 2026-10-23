// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Installs IDL event-handler properties and connects content attributes to listeners.

import { documentImpl as document, ksGlobal } from "../state.js";
import {
  ALL_EVENT_HANDLERS,
  WINDOW_EVENT_HANDLERS,
  LEGACY_LENIENT_THIS,
} from "../event-handler-names.js";
import type { EventHandlerName } from "../event-handler-names.js";
import { BRAND_WRAPPED } from "../webidl.js";
import { setContentAttrHydrator } from "../events/dispatch.js";

const idlEventHandlerNames = ALL_EVENT_HANDLERS;

const idlHandlerSym = Symbol.for("kitesurf.idlEventHandlers");

type HandlerWrapper = (this: HandlerSlotOwner, event: unknown) => unknown;
type HandlerSlot = { fn: Function; wrapper: HandlerWrapper };
type HandlerSlots = Record<string, HandlerSlot | undefined>;
type HandlerSlotOwner = { [idlHandlerSym]?: HandlerSlots };
type HandlerReceiver = HandlerSlotOwner & {
  nodeType: number;
  tagName?: unknown;
  addEventListener?(type: string, listener: HandlerWrapper, capture: boolean): void;
  removeEventListener?(type: string, listener: HandlerWrapper, capture: boolean): void;
};
type ContentAttrTarget = HandlerSlotOwner & {
  _id: number;
  getAttribute(name: string): unknown;
  tagName?: unknown;
};

const idlEventHandlerNameSet: ReadonlySet<string> = new Set(idlEventHandlerNames);

const windowForwardedEventNames = new Set([
  ...WINDOW_EVENT_HANDLERS,
  "onblur",
  "onerror",
  "onfocus",
  "onload",
  "onresize",
  "onscroll",
]);
const hydratedAttrHandlers = new WeakMap<object, Set<string>>();

function isObjectLike(value: unknown): value is object {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function isContentAttrTarget(value: unknown): value is ContentAttrTarget {
  return (
    isObjectLike(value) &&
    typeof Reflect.get(value, "getAttribute") === "function" &&
    typeof Reflect.get(value, "_id") === "number"
  );
}

function markHandlerExplicitlySet(target: object, eventType: string) {
  try {
    let done = hydratedAttrHandlers.get(target);
    if (!done) {
      done = new Set();
      hydratedAttrHandlers.set(target, done);
    }
    done.add(eventType);
  } catch {}
}

setContentAttrHydrator(hydrateContentAttrHandler);

function hydrateContentAttrHandler(rawTarget: unknown, type: string): void {
  const propName = "on" + type;
  if (!idlEventHandlerNameSet.has(propName)) return;
  const target = contentAttrTargetWithWindowFallback(rawTarget, propName);
  if (!isContentAttrTarget(target)) return;
  hydrateAttrHandler(target, propName, type);
}

function contentAttrTargetWithWindowFallback(target: unknown, propName: string): unknown {
  if (!needsWindowBodyFallback(target, propName)) return target;
  return windowBodyFallbackTarget(target) ?? target;
}

function needsWindowBodyFallback(target: unknown, propName: string): target is object {
  return (
    isObjectLike(target) &&
    typeof Reflect.get(target, "getAttribute") !== "function" &&
    windowForwardedEventNames.has(propName)
  );
}

function windowBodyFallbackTarget(target: object): unknown {
  try {
    if (Reflect.get(target, "window") === target && document && document.body) {
      return document.body;
    }
  } catch {}
  return undefined;
}

function hydrateAttrHandler(target: ContentAttrTarget, propName: string, type: string): void {
  if (markAttrHandlerHydrated(target, type)) return;
  if (hasIdlHandler(target, type)) return;
  installContentAttrHandler(target, propName);
}

function installContentAttrHandler(target: ContentAttrTarget, propName: string): void {
  const source = readContentAttr(target, propName);
  if (typeof source !== "string" || !source) return;
  try {
    installAttrEventHandler(target, propName, source);
  } catch {}
}

function markAttrHandlerHydrated(target: object, type: string): boolean {
  let done = hydratedAttrHandlers.get(target);
  if (done?.has(type)) return true;
  if (!done) {
    done = new Set();
    hydratedAttrHandlers.set(target, done);
  }
  done.add(type);
  return false;
}

function hasIdlHandler(target: ContentAttrTarget, type: string): boolean {
  const slots = target[idlHandlerSym];
  return Boolean(slots && slots[type]);
}

function readContentAttr(target: ContentAttrTarget, name: string): unknown {
  try {
    return target.getAttribute(name);
  } catch {
    return null;
  }
}

function installAttrEventHandler(
  element: { tagName?: unknown },
  name: string,
  source: string,
): void {
  const forwardsToWindow = shouldForwardAttrHandler(element, name);
  const fn = compileAttrEventHandler(source);
  if (!fn) return;
  try {
    Reflect.set(element, name, fn);
  } catch {}
  if (forwardsToWindow) forwardHandlerToWindow(name, fn);
}

function shouldForwardAttrHandler(element: { tagName?: unknown }, name: string): boolean {
  let tag = "";
  try {
    tag = String(element.tagName || "").toLowerCase();
  } catch {}
  return (tag === "body" || tag === "frameset") && windowForwardedEventNames.has(name);
}

function compileAttrEventHandler(source: string): Function | null {
  try {
    const Ctor = Function;
    const wrapped =
      "with(typeof window!=='undefined'?window:globalThis){" +
      "with(typeof document!=='undefined'?document:{}){" +
      "with(this){" +
      source +
      "}}}";
    return new Ctor("event", wrapped);
  } catch {
    return null;
  }
}

function forwardHandlerToWindow(name: string, fn: unknown) {
  try {
    ksGlobal[name] = fn;
  } catch {}
  try {
    const win = ksGlobal.window;
    if (win && win !== globalThis) {
      win[name] = fn;
    }
  } catch {}
}

const handlerHasOwn = Object.prototype.hasOwnProperty;
function handlerReceiverOk(v: unknown): v is HandlerReceiver {
  return (
    v !== null &&
    typeof v === "object" &&
    !handlerHasOwn.call(v, "constructor") &&
    typeof Reflect.get(v, "nodeType") === "number"
  );
}

function nameHandlerAccessor<F extends Function>(fn: F, name: string): F {
  Object.defineProperty(fn, "name", {
    value: name,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Reflect.set(fn, BRAND_WRAPPED, true);
  return fn;
}

function isWindowForwardedReceiver(el: { tagName?: unknown }, propName: string) {
  if (!windowForwardedEventNames.has(propName)) return false;
  let tag = "";
  try {
    tag = String(el.tagName || "").toLowerCase();
  } catch {}
  return tag === "body" || tag === "frameset";
}

function windowHandlerValue(propName: string): unknown {
  const win: unknown = Reflect.get(globalThis, "window");
  if (win && (typeof win === "object" || typeof win === "function")) {
    return Reflect.get(win, propName) ?? null;
  }
  return null;
}

function getIdlHandler(
  receiver: unknown,
  propName: string,
  eventType: string,
  lenient: boolean,
): unknown {
  const target = requireHandlerReceiver(receiver, lenient);
  if (!target) return undefined;
  if (isWindowForwardedReceiver(target, propName)) return windowHandlerValue(propName);
  const slots = target[idlHandlerSym];
  if (!slots) return null;
  const entry = slots[eventType];
  return entry ? entry.fn : null;
}

function requireHandlerReceiver(receiver: unknown, lenient: boolean): HandlerReceiver | undefined {
  if (handlerReceiverOk(receiver)) return receiver;
  if (lenient) return undefined;
  throw new TypeError("Illegal invocation");
}

function setIdlHandler(
  receiver: unknown,
  propName: string,
  eventType: string,
  lenient: boolean,
  value: unknown,
): void {
  const target = requireHandlerReceiver(receiver, lenient);
  if (!target) return;
  markHandlerExplicitlySet(target, eventType);
  if (isWindowForwardedReceiver(target, propName)) {
    forwardHandlerToWindow(propName, value);
    return;
  }
  const slots = getOrCreateHandlerSlots(target);
  removeIdlHandler(target, slots, eventType);
  if (typeof value !== "function") return;
  addIdlHandler(target, slots, eventType, value);
}

function getOrCreateHandlerSlots(target: HandlerReceiver): HandlerSlots {
  const existingSlots = target[idlHandlerSym];
  const slots: HandlerSlots = existingSlots || Object.create(null);
  if (!existingSlots) {
    Object.defineProperty(target, idlHandlerSym, {
      value: slots,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }
  return slots;
}

function removeIdlHandler(target: HandlerReceiver, slots: HandlerSlots, eventType: string): void {
  const prev = slots[eventType];
  if (!prev) return;
  target.removeEventListener?.(eventType, prev.wrapper, false);
  delete slots[eventType];
}

function addIdlHandler(
  target: HandlerReceiver,
  slots: HandlerSlots,
  eventType: string,
  value: Function,
): void {
  const wrapper: HandlerWrapper = function (event) {
    const slot = (this[idlHandlerSym] || {})[eventType];
    const fn = slot && slot.fn;
    if (typeof fn !== "function") return undefined;
    return fn.call(this, event);
  };
  slots[eventType] = { fn: value, wrapper };
  target.addEventListener?.(eventType, wrapper, false);
}

function installIdlHandlersOn(
  proto: object,
  names: readonly EventHandlerName[] = idlEventHandlerNames,
): void {
  for (const propName of names) {
    const eventType = propName.slice(2);
    const lenient = LEGACY_LENIENT_THIS.has(propName);
    const getter = nameHandlerAccessor(function (this: unknown) {
      return getIdlHandler(this, propName, eventType, lenient);
    }, "get " + propName);
    const setter = nameHandlerAccessor(function (this: unknown, value: unknown) {
      setIdlHandler(this, propName, eventType, lenient, value);
    }, "set " + propName);
    Object.defineProperty(proto, propName, {
      configurable: true,
      enumerable: true,
      get: getter,
      set: setter,
    });
  }
}

export { idlEventHandlerNameSet, installAttrEventHandler, installIdlHandlersOn };
