// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Engine-provided functions are JS shims, so they stringified as their minified source. A
// browser prints NativeFunction syntax for built-ins, and isNative checks rely on it.

import { getInternalState } from "./internal-state.js";

const nativeNames = new WeakMap<object, string>();
const realToString = Function.prototype.toString;
const REAL_NATIVE = /^function [\w$]+\(\) \{\s*\[native code\]\s*\}$/;

function propertyName(key: string | symbol): string {
  return typeof key === "symbol" ? `[${key.description ?? ""}]` : key;
}

// A workerd built-in already prints the right thing under its own name; a bound copy prints
// "function () { [native code] }" and is named "bound x", so it is ours.
export function markNative(fn: unknown, name: string, accessor = false): void {
  if (typeof fn !== "function" || nativeNames.has(fn)) return;
  let src: string;
  try {
    src = realToString.call(fn);
  } catch {
    return;
  }
  let own: string;
  try {
    own = typeof fn.name === "string" ? fn.name : "";
  } catch {
    return;
  }
  const bound = own.startsWith("bound ");
  if (REAL_NATIVE.test(src) && own && !bound) return;
  const effective = accessor || !own || bound ? name : own;
  if (!effective) return;
  nativeNames.set(fn, effective);
  if (own !== effective) {
    try {
      Object.defineProperty(fn, "name", { value: effective, configurable: true });
    } catch {}
  }
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

export function markEngineFunctions(roots: readonly unknown[]): void {
  const MAX_OBJECT_TRAVERSAL_DEPTH = 1;
  const MAX_PROTOTYPE_CHAIN_HOPS = 8;
  const seen = new Set<object>();
  const visit = (obj: unknown, depth: number): void => {
    if ((typeof obj !== "object" && typeof obj !== "function") || obj === null) return;
    if (obj === Object.prototype || obj === Function.prototype || seen.has(obj)) return;
    seen.add(obj);
    let keys: (string | symbol)[];
    try {
      keys = Reflect.ownKeys(obj);
    } catch {
      return;
    }
    for (const key of keys) {
      try {
        visitKey(obj, key, depth);
      } catch {}
    }
  };
  const visitKey = (obj: object, key: string | symbol, depth: number): void => {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    if (!d) return;
    const name = propertyName(key);
    if (d.get) markNative(d.get, `get ${name}`, true);
    if (d.set) markNative(d.set, `set ${name}`, true);
    const value = d.value;
    if (typeof value === "function") {
      markNative(value, name);
      if (key !== "constructor") visit(value, depth);
      const proto = Object.prototype.hasOwnProperty.call(value, "prototype")
        ? value.prototype
        : null;
      visitChain(proto, depth);
    } else if (
      value &&
      typeof value === "object" &&
      depth < MAX_OBJECT_TRAVERSAL_DEPTH &&
      !Array.isArray(value) &&
      !ArrayBuffer.isView(value)
    ) {
      visit(value, depth + 1);
      visitChain(Object.getPrototypeOf(value), depth + 1);
    }
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
