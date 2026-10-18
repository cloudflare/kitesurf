// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Finalizes shim interface names, prototype chains, descriptors, and receiver-brand checks.

import type { WebIdlRuntimeInterface } from "./idl/model.js";
import { WEBIDL_RUNTIME } from "./idl/runtime.generated.js";

export interface InterfaceMeta {
  name: string;
  length?: number;
  constants?: Record<string, number | boolean>;
  methodLengths?: Record<string, number>;
  staticMethodLengths?: Record<string, number>;
  brandOps?: boolean;
  brandAttrs?: boolean;
  brandDuck?: boolean;
  parent?: any;
  strictInstance?: boolean;
  promiseOps?: string[];
}

export const BRAND_WRAPPED = Symbol("ks-brand-wrapped");

export function markBrandWrapped(fn: object): void {
  Reflect.set(fn, BRAND_WRAPPED, true);
}

function isBrandWrapped(fn: object): boolean {
  return Reflect.get(fn, BRAND_WRAPPED) === true;
}

const FINALIZED_NAME = Symbol("ks-finalized-name");

const isProtoOf = Object.prototype.isPrototypeOf;
const hasOwn = Object.prototype.hasOwnProperty;

function makeBrandCheck(proto: any, duck: boolean | undefined) {
  if (!duck) return (v: any) => isProtoOf.call(proto, v);
  return (v: any) =>
    isProtoOf.call(proto, v) ||
    (v !== null &&
      typeof v === "object" &&
      !hasOwn.call(v, "constructor") &&
      typeof v.nodeType === "number");
}

function brandWrapOp(
  fn: any,
  required: number | undefined,
  check: (v: any) => boolean,
  promiseReturning?: boolean,
): any {
  if (fn[BRAND_WRAPPED]) return fn;
  const wrapped = function (this: any) {
    if (!check(this)) {
      const err = new TypeError("Illegal invocation");
      if (promiseReturning) return Promise.reject(err);
      throw err;
    }
    if (required !== undefined && arguments.length < required) {
      const err = new TypeError(
        `Failed to execute '${fn.name}': ${required} argument` +
          (required === 1 ? "" : "s") +
          ` required, but only ${arguments.length} present.`,
      );
      if (promiseReturning) return Promise.reject(err);
      throw err;
    }
    // eslint-disable-next-line prefer-rest-params
    return fn.apply(this, arguments as any);
  };
  Object.defineProperty(wrapped, "name", {
    value: fn.name,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(wrapped, "length", {
    value: fn.length,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  markBrandWrapped(wrapped);
  return wrapped;
}

function brandWrapAccessor(fn: any, name: string, check: (v: any) => boolean): any {
  const wrapped = function (this: any, v?: any) {
    if (!check(this)) throw new TypeError("Illegal invocation");
    return fn.call(this, v);
  };
  Object.defineProperty(wrapped, "name", {
    value: name,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(wrapped, "length", {
    value: fn.length,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  markBrandWrapped(wrapped);
  return wrapped;
}

function redefine(obj: any, key: PropertyKey, desc: PropertyDescriptor): void {
  const cur = Object.getOwnPropertyDescriptor(obj, key);
  if (cur && !cur.configurable) return;
  Object.defineProperty(obj, key, desc);
}

/** Applies pinned WebIDL names, prototype links, descriptors, and receiver checks to a class. */
export function finalizeInterface(C: any, meta: InterfaceMeta): void {
  const proto = C.prototype;
  const prior = Object.prototype.hasOwnProperty.call(C, FINALIZED_NAME)
    ? (C as any)[FINALIZED_NAME]
    : undefined;
  if (prior !== undefined && prior !== meta.name) return;
  if (prior === undefined) {
    Object.defineProperty(C, FINALIZED_NAME, {
      value: meta.name,
      writable: false,
      enumerable: false,
      configurable: true,
    });
  }
  if (meta.parent) {
    if (Object.getPrototypeOf(C) !== meta.parent) {
      Object.setPrototypeOf(C, meta.parent);
    }
    if (Object.getPrototypeOf(proto) !== meta.parent.prototype) {
      Object.setPrototypeOf(proto, meta.parent.prototype);
    }
  }
  if (
    (meta.parent || meta.strictInstance) &&
    !Object.prototype.hasOwnProperty.call(C, Symbol.hasInstance)
  ) {
    Object.defineProperty(C, Symbol.hasInstance, {
      value: (v: any) => v != null && proto.isPrototypeOf(v),
      writable: false,
      enumerable: false,
      configurable: true,
    });
  }
  redefine(C, "name", {
    value: meta.name,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  if (meta.length !== undefined) {
    redefine(C, "length", {
      value: meta.length,
      writable: false,
      enumerable: false,
      configurable: true,
    });
  }
  const check = makeBrandCheck(proto, meta.brandDuck);
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key === "constructor" || key.startsWith("_")) continue;
    const d = Object.getOwnPropertyDescriptor(proto, key);
    if (!d || !d.configurable) continue;
    let changed = !d.enumerable;
    d.enumerable = true;
    if (meta.brandOps && typeof d.value === "function" && !d.value[BRAND_WRAPPED]) {
      d.value = brandWrapOp(
        d.value,
        meta.methodLengths ? meta.methodLengths[key] : undefined,
        check,
        meta.promiseOps ? meta.promiseOps.includes(key) : false,
      );
      changed = true;
    }
    if (meta.brandAttrs) {
      if (d.get && !isBrandWrapped(d.get)) {
        d.get = brandWrapAccessor(d.get, `get ${key}`, check);
        changed = true;
      }
      if (d.set && !isBrandWrapped(d.set)) {
        d.set = brandWrapAccessor(d.set, `set ${key}`, check);
        changed = true;
      }
    }
    if (changed) Object.defineProperty(proto, key, d);
  }
  redefine(proto, Symbol.toStringTag, {
    value: meta.name,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  if (meta.constants) {
    for (const k of Object.keys(meta.constants)) {
      const desc: PropertyDescriptor = {
        value: meta.constants[k],
        writable: false,
        enumerable: true,
        configurable: false,
      };
      redefine(C, k, desc);
      redefine(proto, k, desc);
    }
  }
  const it = Object.getOwnPropertyDescriptor(proto, Symbol.iterator);
  if (it && it.enumerable && it.configurable) {
    it.enumerable = false;
    Object.defineProperty(proto, Symbol.iterator, it);
  }
  if (meta.methodLengths) {
    for (const m of Object.keys(meta.methodLengths)) {
      const d = Object.getOwnPropertyDescriptor(proto, m);
      if (d && typeof d.value === "function") {
        redefine(d.value, "length", {
          value: meta.methodLengths[m],
          writable: false,
          enumerable: false,
          configurable: true,
        });
      }
    }
  }
  if (meta.staticMethodLengths) {
    for (const name of Object.keys(meta.staticMethodLengths)) {
      const d = Object.getOwnPropertyDescriptor(C, name);
      if (!d || typeof d.value !== "function" || !d.configurable) continue;
      if (!d.value[BRAND_WRAPPED]) {
        d.value = brandWrapOp(d.value, meta.staticMethodLengths[name], () => true, false);
      }
      d.enumerable = true;
      Object.defineProperty(C, name, d);
      redefine(d.value, "length", {
        value: meta.staticMethodLengths[name],
        writable: false,
        enumerable: false,
        configurable: true,
      });
    }
  }
}

export type IdlInterfaceName = keyof typeof WEBIDL_RUNTIME;

export function idlInterfaceMeta(
  name: IdlInterfaceName,
  extra: Omit<Partial<InterfaceMeta>, "name"> = {},
): InterfaceMeta {
  const chain: WebIdlRuntimeInterface[] = [];
  for (let n: string | undefined = name; n !== undefined && hasOwn.call(WEBIDL_RUNTIME, n);) {
    const entry: WebIdlRuntimeInterface = WEBIDL_RUNTIME[n as IdlInterfaceName];
    chain.unshift(entry);
    n = entry.parent;
  }
  const own: WebIdlRuntimeInterface = WEBIDL_RUNTIME[name];
  const methodLengths: Record<string, number> = {};
  const promiseOps = new Set<string>(extra.promiseOps);
  for (const entry of chain) {
    Object.assign(methodLengths, entry.methodLengths);
    for (const op of entry.promiseOps ?? []) promiseOps.add(op);
  }
  Object.assign(methodLengths, extra.methodLengths);
  return {
    length: own.length,
    ...extra,
    name,
    constants: { ...own.constants, ...extra.constants },
    methodLengths,
    staticMethodLengths: { ...own.staticMethodLengths, ...extra.staticMethodLengths },
    promiseOps: [...promiseOps],
  };
}

interface GeneratedInterfaceMeta {
  readonly name: string;
  readonly parent?: string;
  readonly length: number;
  readonly constructible: boolean;
  readonly methodLengths: Readonly<Record<string, number>>;
  readonly staticMethodLengths: Readonly<Record<string, number>>;
  readonly iterable?: "pair" | "value" | null;
}

function generatedInterfaceObject(implementation: any, constructible: boolean): any {
  const exposed = function (this: any) {
    if (!constructible || !new.target) throw new TypeError("Illegal constructor");
    return Reflect.construct(implementation, Array.from(arguments), new.target);
  };
  for (const key of Reflect.ownKeys(implementation)) {
    if (key === "name" || key === "length" || key === "prototype") continue;
    const descriptor = Object.getOwnPropertyDescriptor(implementation, key);
    if (descriptor) Object.defineProperty(exposed, key, descriptor);
  }
  Object.defineProperty(exposed, "prototype", {
    value: implementation.prototype,
    writable: false,
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(implementation.prototype, "constructor", {
    value: exposed,
    writable: true,
    enumerable: false,
    configurable: true,
  });
  return exposed;
}

export function finalizeGeneratedInterfaces(
  globals: Record<string, any>,
  interfaces: readonly GeneratedInterfaceMeta[],
): void {
  for (const meta of interfaces) {
    const implementation = globals[meta.name];
    if (typeof implementation !== "function" || !implementation.prototype) continue;
    globals[meta.name] = generatedInterfaceObject(implementation, meta.constructible);
  }
  for (const meta of interfaces) {
    const C = globals[meta.name];
    if (typeof C !== "function" || !C.prototype) continue;
    const parent = meta.parent ? globals[meta.parent] : undefined;
    finalizeInterface(C, {
      name: meta.name,
      length: meta.length,
      ...(parent ? { parent } : {}),
      methodLengths: { ...meta.methodLengths },
      staticMethodLengths: { ...meta.staticMethodLengths },
      brandOps: true,
      brandAttrs: true,
    });
  }
  const byName = new Map(interfaces.map((meta) => [meta.name, meta]));
  for (const meta of interfaces) {
    const C = globals[meta.name];
    if (typeof C !== "function" || !C.prototype) continue;
    let parent = meta.parent ? byName.get(meta.parent) : undefined;
    while (parent) {
      const parentInterface = globals[parent.name];
      for (const name of Object.keys(parent.staticMethodLengths)) {
        if (hasOwn.call(C, name)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(parentInterface, name);
        if (descriptor) Object.defineProperty(C, name, descriptor);
      }
      parent = parent.parent ? byName.get(parent.parent) : undefined;
    }
    if (meta.iterable === "pair") {
      Object.defineProperty(C.prototype, Symbol.iterator, {
        value: C.prototype.entries,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    } else if (meta.iterable === "value") {
      for (const name of ["entries", "keys", "values", "forEach"] as const) {
        Object.defineProperty(C.prototype, name, {
          value: Array.prototype[name],
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      Object.defineProperty(C.prototype, Symbol.iterator, {
        value: Array.prototype[Symbol.iterator],
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  }
}

export function defineReadonlyAttrs(
  C: any,
  attrs: Record<string, string | ((self: any) => any)>,
): void {
  for (const name of Object.keys(attrs)) {
    const src = attrs[name];
    const read = typeof src === "function" ? src : (self: any) => self[src];
    const getter = function (this: any) {
      if (!isProtoOf.call(C.prototype, this)) throw new TypeError("Illegal invocation");
      return read(this);
    };
    Object.defineProperty(getter, "name", {
      value: `get ${name}`,
      writable: false,
      enumerable: false,
      configurable: true,
    });
    markBrandWrapped(getter);
    Object.defineProperty(C.prototype, name, {
      enumerable: true,
      configurable: true,
      get: getter,
    });
  }
}
