// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Installs IDL event-handler properties and connects content attributes to listeners.

import { documentImpl as document, ksGlobal, ksGlobalByKey } from "../state.js";
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

setContentAttrHydrator((rawTarget: unknown, type: string) => {
  const propName = "on" + type;
  if (!idlEventHandlerNameSet.has(propName)) return;
  let target = rawTarget;
  if (
    isObjectLike(target) &&
    typeof Reflect.get(target, "getAttribute") !== "function" &&
    windowForwardedEventNames.has(propName)
  ) {
    try {
      if (Reflect.get(target, "window") === target && document && document.body) {
        target = document.body;
      }
    } catch {}
  }
  if (!isContentAttrTarget(target)) return;
  let done = hydratedAttrHandlers.get(target);
  if (done && done.has(type)) return;
  if (!done) {
    done = new Set();
    hydratedAttrHandlers.set(target, done);
  }
  done.add(type);
  const slots = target[idlHandlerSym];
  if (slots && slots[type]) return;
  let val: unknown = null;
  try {
    val = target.getAttribute(propName);
  } catch {}
  if (typeof val === "string" && val) {
    try {
      installAttrEventHandler(target, propName, val);
    } catch {}
  }
});

// page-script owns the document's CSP; null admits every handler.
let inlineHandlerGate: ((name: string) => boolean) | null = null;

/** Installs the check an inline on* attribute must pass before it compiles. */
export function setInlineHandlerGate(gate: ((name: string) => boolean) | null): void {
  inlineHandlerGate = gate;
}

function installAttrEventHandler(
  element: { tagName?: unknown },
  name: string,
  source: string,
): void {
  if (inlineHandlerGate && !inlineHandlerGate(name)) return;
  let tag = "";
  try {
    tag = String(element.tagName || "").toLowerCase();
  } catch {}
  const forwardsToWindow =
    (tag === "body" || tag === "frameset") && windowForwardedEventNames.has(name);
  let fn;
  try {
    const Ctor = Function;
    const wrapped =
      "with(typeof window!=='undefined'?window:globalThis){" +
      "with(typeof document!=='undefined'?document:{}){" +
      "with(this){" +
      source +
      "}}}";
    fn = new Ctor("event", wrapped);
  } catch {
    return;
  }
  try {
    Reflect.set(element, name, fn);
  } catch {}
  if (forwardsToWindow) {
    forwardHandlerToWindow(name, fn);
  }
}

function forwardHandlerToWindow(name: string, fn: unknown) {
  try {
    ksGlobalByKey[name] = fn;
  } catch {}
  try {
    const win = ksGlobal.window;
    if (typeof win === "object" && win !== null && win !== globalThis) {
      Reflect.set(win, name, fn);
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

function installIdlHandlersOn(
  proto: object,
  names: readonly EventHandlerName[] = idlEventHandlerNames,
): void {
  for (const propName of names) {
    const eventType = propName.slice(2);
    const lenient = LEGACY_LENIENT_THIS.has(propName);
    const getter = nameHandlerAccessor(function (this: unknown) {
      if (!handlerReceiverOk(this)) {
        if (lenient) return undefined;
        throw new TypeError("Illegal invocation");
      }
      if (isWindowForwardedReceiver(this, propName)) {
        return windowHandlerValue(propName);
      }
      const slots = this[idlHandlerSym];
      if (!slots) return null;
      const entry = slots[eventType];
      return entry ? entry.fn : null;
    }, "get " + propName);
    const setter = nameHandlerAccessor(function (this: unknown, value: unknown) {
      if (!handlerReceiverOk(this)) {
        if (lenient) return;
        throw new TypeError("Illegal invocation");
      }
      markHandlerExplicitlySet(this, eventType);
      if (isWindowForwardedReceiver(this, propName)) {
        forwardHandlerToWindow(propName, value);
        return;
      }
      const existingSlots = this[idlHandlerSym];
      const slots: HandlerSlots = existingSlots || Object.create(null);
      if (!existingSlots) {
        Object.defineProperty(this, idlHandlerSym, {
          value: slots,
          enumerable: false,
          configurable: true,
          writable: false,
        });
      }
      const prev = slots[eventType];
      if (prev) {
        this.removeEventListener?.(eventType, prev.wrapper, false);
        delete slots[eventType];
      }
      if (typeof value !== "function") return;
      const wrapper: HandlerWrapper = function (event) {
        const slot = (this[idlHandlerSym] || {})[eventType];
        const fn = slot && slot.fn;
        if (typeof fn !== "function") return undefined;
        return fn.call(this, event);
      };
      slots[eventType] = { fn: value, wrapper };
      this.addEventListener?.(eventType, wrapper, false);
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
