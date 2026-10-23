// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Engine-provided functions are JS shims, so they stringified as their minified source. A
// browser prints NativeFunction syntax for built-ins, and isNative checks rely on it.

import { getInternalState } from "./internal-state.js";

const nativeNames = new WeakMap<object, string>();
const realToString = Function.prototype.toString;
const REAL_NATIVE = /^function [\w$]+\(\) \{\s*\[native code\]\s*\}$/;

function isUntrackedFunction(fn: unknown): fn is Function {
  return typeof fn === "function" && !nativeNames.has(fn);
}

function nativeSource(fn: Function): string | null {
  try {
    return realToString.call(fn);
  } catch {
    return null;
  }
}

function ownFunctionName(fn: Function): string | null {
  try {
    return typeof fn.name === "string" ? fn.name : "";
  } catch {
    return null;
  }
}

function isExistingNative(src: string, own: string, bound: boolean): boolean {
  return REAL_NATIVE.test(src) && !!own && !bound;
}

function effectiveNativeName(accessor: boolean, own: string, bound: boolean, name: string): string {
  return accessor || !own || bound ? name : own;
}

function registerNativeName(fn: Function, own: string, effective: string): void {
  if (!effective) return;
  nativeNames.set(fn, effective);
  if (own !== effective) {
    try {
      Object.defineProperty(fn, "name", { value: effective, configurable: true });
    } catch {}
  }
}

function markNativeImpl(fn: unknown, name: string, accessor: boolean): void {
  if (!isUntrackedFunction(fn)) return;
  const src = nativeSource(fn);
  if (src === null) return;
  const own = ownFunctionName(fn);
  if (own === null) return;
  const bound = own.startsWith("bound ");
  if (isExistingNative(src, own, bound)) return;
  const effective = effectiveNativeName(accessor, own, bound, name);
  registerNativeName(fn, own, effective);
}

function propertyName(key: string | symbol): string {
  return typeof key === "symbol" ? `[${key.description ?? ""}]` : key;
}

// A workerd built-in already prints the right thing under its own name; a bound copy prints
// "function () { [native code] }" and is named "bound x", so it is ours.
export function markNative(fn: unknown, name: string, accessor = false): void {
  markNativeImpl(fn, name, accessor);
}

let toStringInstalled = false;
export function installNativeToString(): void {
  if (toStringInstalled) return;
  toStringInstalled = true;
  const { toString } = {
    toString(this: unknown): string {
      if ((typeof this === "function" || typeof this === "object") && this !== null) {
        const name = nativeNames.get(this);
        if (name !== undefined) return `function ${name}() { [native code] }`;
      }
      return realToString.call(this as () => void);
    },
  };
  nativeNames.set(toString, "toString");
  Object.defineProperty(Function.prototype, "toString", {
    value: toString,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  getInternalState().markNative = markNative;
}

const MAX_OBJECT_TRAVERSAL_DEPTH = 1;
const MAX_PROTOTYPE_CHAIN_HOPS = 8;

type NativeVisit = (obj: unknown, depth: number) => void;
type NativeVisitChain = (proto: unknown, depth: number) => void;

function isObjectLike(value: unknown): value is object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

function shouldSkipNativeObject(obj: object, seen: Set<object>): boolean {
  return obj === Object.prototype || obj === Function.prototype || seen.has(obj);
}

function ownKeysOf(obj: object): (string | symbol)[] | null {
  try {
    return Reflect.ownKeys(obj);
  } catch {
    return null;
  }
}

function isShallowEngineObject(value: unknown, depth: number): value is object {
  return (
    !!value &&
    typeof value === "object" &&
    depth < MAX_OBJECT_TRAVERSAL_DEPTH &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value)
  );
}

function markNativeAccessors(descriptor: PropertyDescriptor, name: string): void {
  if (descriptor.get) markNative(descriptor.get, `get ${name}`, true);
  if (descriptor.set) markNative(descriptor.set, `set ${name}`, true);
}

function visitNativeFunction(
  value: Function,
  key: string | symbol,
  name: string,
  depth: number,
  visit: NativeVisit,
  visitChain: NativeVisitChain,
): void {
  markNative(value, name);
  if (key !== "constructor") visit(value, depth);
  const proto = Object.prototype.hasOwnProperty.call(value, "prototype") ? value.prototype : null;
  visitChain(proto, depth);
}

function visitNativeKey(
  obj: object,
  key: string | symbol,
  depth: number,
  visit: NativeVisit,
  visitChain: NativeVisitChain,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(obj, key);
  if (!descriptor) return;
  const name = propertyName(key);
  markNativeAccessors(descriptor, name);
  const value = descriptor.value;
  if (typeof value === "function") {
    visitNativeFunction(value, key, name, depth, visit, visitChain);
    return;
  }
  if (!isShallowEngineObject(value, depth)) return;
  visit(value, depth + 1);
  visitChain(Object.getPrototypeOf(value), depth + 1);
}

function visitNativeKeys(
  obj: object,
  keys: (string | symbol)[],
  depth: number,
  visit: NativeVisit,
  visitChain: NativeVisitChain,
): void {
  for (const key of keys) {
    try {
      visitNativeKey(obj, key, depth, visit, visitChain);
    } catch {}
  }
}

export function markEngineFunctions(roots: readonly unknown[]): void {
  const seen = new Set<object>();
  const visit = (obj: unknown, depth: number): void => {
    if (!isObjectLike(obj)) return;
    if (shouldSkipNativeObject(obj, seen)) return;
    seen.add(obj);
    const keys = ownKeysOf(obj);
    if (!keys) return;
    visitNativeKeys(obj, keys, depth, visit, visitChain);
  };
  const visitChain = (proto: unknown, depth: number): void => {
    try {
      for (
        let prototype = proto, hops = 0;
        prototype && hops < MAX_PROTOTYPE_CHAIN_HOPS;
        prototype = Object.getPrototypeOf(prototype), hops++
      ) {
        visit(prototype, depth);
      }
    } catch {}
  };
  for (const root of roots) {
    visit(root, 0);
    try {
      visitChain(Object.getPrototypeOf(root), 0);
    } catch {}
  }
}
