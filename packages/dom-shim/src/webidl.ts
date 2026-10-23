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
    return invokeBrandedOperation(fn, required, check, promiseReturning, this, arguments);
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

function rejectOrThrow(error: TypeError, promiseReturning: boolean | undefined): any {
  if (promiseReturning) return Promise.reject(error);
  throw error;
}

function insufficientArguments(required: number | undefined, actual: number): boolean {
  return required !== undefined && actual < required;
}

function tooFewArgumentsError(fn: any, required: number | undefined, actual: number): TypeError {
  return new TypeError(
    `Failed to execute '${fn.name}': ${required} argument` +
      (required === 1 ? "" : "s") +
      ` required, but only ${actual} present.`,
  );
}

function invokeBrandedOperation(
  fn: any,
  required: number | undefined,
  check: (v: any) => boolean,
  promiseReturning: boolean | undefined,
  receiver: any,
  args: IArguments,
): any {
  if (!check(receiver)) return rejectOrThrow(new TypeError("Illegal invocation"), promiseReturning);
  if (insufficientArguments(required, args.length)) {
    return rejectOrThrow(tooFewArgumentsError(fn, required, args.length), promiseReturning);
  }
  // eslint-disable-next-line prefer-rest-params
  return fn.apply(receiver, args as any);
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

function markInterfaceFinalized(C: any, name: string): boolean {
  const prior = hasOwn.call(C, FINALIZED_NAME) ? C[FINALIZED_NAME] : undefined;
  if (prior !== undefined && prior !== name) return false;
  if (prior === undefined) {
    Object.defineProperty(C, FINALIZED_NAME, {
      value: name,
      writable: false,
      enumerable: false,
      configurable: true,
    });
  }
  return true;
}

function linkInterfaceParent(C: any, proto: any, parent: any): void {
  if (!parent) return;
  if (Object.getPrototypeOf(C) !== parent) Object.setPrototypeOf(C, parent);
  if (Object.getPrototypeOf(proto) !== parent.prototype) {
    Object.setPrototypeOf(proto, parent.prototype);
  }
}

function installHasInstance(C: any, proto: any, meta: InterfaceMeta): void {
  if (!meta.parent && !meta.strictInstance) return;
  if (hasOwn.call(C, Symbol.hasInstance)) return;
  Object.defineProperty(C, Symbol.hasInstance, {
    value: (v: any) => v != null && proto.isPrototypeOf(v),
    writable: false,
    enumerable: false,
    configurable: true,
  });
}

function finalizeInterfaceName(C: any, meta: InterfaceMeta): void {
  redefine(C, "name", {
    value: meta.name,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  if (meta.length === undefined) return;
  redefine(C, "length", {
    value: meta.length,
    writable: false,
    enumerable: false,
    configurable: true,
  });
}

function wrapPrototypeOperation(
  descriptor: PropertyDescriptor,
  key: string,
  meta: InterfaceMeta,
  check: (value: any) => boolean,
): boolean {
  if (!shouldWrapPrototypeOperation(descriptor, meta)) return false;
  descriptor.value = brandWrapOp(
    descriptor.value,
    meta.methodLengths ? meta.methodLengths[key] : undefined,
    check,
    meta.promiseOps ? meta.promiseOps.includes(key) : false,
  );
  return true;
}

function shouldWrapPrototypeOperation(
  descriptor: PropertyDescriptor,
  meta: InterfaceMeta,
): boolean {
  return (
    !!meta.brandOps && typeof descriptor.value === "function" && !descriptor.value[BRAND_WRAPPED]
  );
}

function wrapPrototypeGetter(
  descriptor: PropertyDescriptor,
  key: string,
  check: (value: any) => boolean,
): boolean {
  if (!descriptor.get || isBrandWrapped(descriptor.get)) return false;
  descriptor.get = brandWrapAccessor(descriptor.get, `get ${key}`, check);
  return true;
}

function wrapPrototypeSetter(
  descriptor: PropertyDescriptor,
  key: string,
  check: (value: any) => boolean,
): boolean {
  if (!descriptor.set || isBrandWrapped(descriptor.set)) return false;
  descriptor.set = brandWrapAccessor(descriptor.set, `set ${key}`, check);
  return true;
}

function wrapPrototypeAccessors(
  descriptor: PropertyDescriptor,
  key: string,
  meta: InterfaceMeta,
  check: (value: any) => boolean,
): boolean {
  if (!meta.brandAttrs) return false;
  const wrappedGetter = wrapPrototypeGetter(descriptor, key, check);
  const wrappedSetter = wrapPrototypeSetter(descriptor, key, check);
  return wrappedGetter || wrappedSetter;
}

function finalizePrototypeMember(
  proto: any,
  key: string,
  descriptor: PropertyDescriptor,
  meta: InterfaceMeta,
  check: (value: any) => boolean,
): void {
  let changed = !descriptor.enumerable;
  descriptor.enumerable = true;
  if (wrapPrototypeOperation(descriptor, key, meta, check)) changed = true;
  if (wrapPrototypeAccessors(descriptor, key, meta, check)) changed = true;
  if (changed) Object.defineProperty(proto, key, descriptor);
}

function finalizePrototypeMembers(
  proto: any,
  meta: InterfaceMeta,
  check: (v: any) => boolean,
): void {
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (!isPublicInterfaceMember(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(proto, key);
    if (!descriptor || !descriptor.configurable) continue;
    finalizePrototypeMember(proto, key, descriptor, meta, check);
  }
}

function isPublicInterfaceMember(key: string): boolean {
  return key !== "constructor" && !key.startsWith("_");
}

function finalizeInterfaceConstants(
  C: any,
  proto: any,
  constants: InterfaceMeta["constants"],
): void {
  if (!constants) return;
  for (const key of Object.keys(constants)) {
    const descriptor: PropertyDescriptor = {
      value: constants[key],
      writable: false,
      enumerable: true,
      configurable: false,
    };
    redefine(C, key, descriptor);
    redefine(proto, key, descriptor);
  }
}

function hideEnumerableIterator(proto: any): void {
  const descriptor = Object.getOwnPropertyDescriptor(proto, Symbol.iterator);
  if (!descriptor || !descriptor.enumerable || !descriptor.configurable) return;
  descriptor.enumerable = false;
  Object.defineProperty(proto, Symbol.iterator, descriptor);
}

function finalizeMethodLengths(proto: any, methodLengths: InterfaceMeta["methodLengths"]): void {
  if (!methodLengths) return;
  for (const name of Object.keys(methodLengths)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (descriptor && typeof descriptor.value === "function") {
      redefine(descriptor.value, "length", {
        value: methodLengths[name],
        writable: false,
        enumerable: false,
        configurable: true,
      });
    }
  }
}

function finalizeStaticMethodLength(C: any, name: string, length: number): void {
  const descriptor = Object.getOwnPropertyDescriptor(C, name);
  if (!descriptor || typeof descriptor.value !== "function" || !descriptor.configurable) return;
  if (!descriptor.value[BRAND_WRAPPED]) {
    descriptor.value = brandWrapOp(descriptor.value, length, () => true, false);
  }
  descriptor.enumerable = true;
  Object.defineProperty(C, name, descriptor);
  redefine(descriptor.value, "length", {
    value: length,
    writable: false,
    enumerable: false,
    configurable: true,
  });
}

function finalizeStaticMethodLengths(C: any, lengths: InterfaceMeta["staticMethodLengths"]): void {
  if (!lengths) return;
  for (const name of Object.keys(lengths)) finalizeStaticMethodLength(C, name, lengths[name]);
}

/** Applies pinned WebIDL names, prototype links, descriptors, and receiver checks to a class. */
export function finalizeInterface(C: any, meta: InterfaceMeta): void {
  const proto = C.prototype;
  if (!markInterfaceFinalized(C, meta.name)) return;
  linkInterfaceParent(C, proto, meta.parent);
  installHasInstance(C, proto, meta);
  finalizeInterfaceName(C, meta);
  const check = makeBrandCheck(proto, meta.brandDuck);
  finalizePrototypeMembers(proto, meta, check);
  redefine(proto, Symbol.toStringTag, {
    value: meta.name,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  finalizeInterfaceConstants(C, proto, meta.constants);
  hideEnumerableIterator(proto);
  finalizeMethodLengths(proto, meta.methodLengths);
  finalizeStaticMethodLengths(C, meta.staticMethodLengths);
}

export type IdlInterfaceName = keyof typeof WEBIDL_RUNTIME;

function inheritedInterfaceChain(name: IdlInterfaceName): WebIdlRuntimeInterface[] {
  const chain: WebIdlRuntimeInterface[] = [];
  for (
    let current: string | undefined = name;
    current !== undefined && hasOwn.call(WEBIDL_RUNTIME, current);
  ) {
    const entry: WebIdlRuntimeInterface = WEBIDL_RUNTIME[current as IdlInterfaceName];
    chain.unshift(entry);
    current = entry.parent;
  }
  return chain;
}

function inheritedMethodLengths(
  chain: WebIdlRuntimeInterface[],
  extra: Omit<Partial<InterfaceMeta>, "name">,
): Record<string, number> {
  const methodLengths: Record<string, number> = {};
  for (const entry of chain) {
    Object.assign(methodLengths, entry.methodLengths);
  }
  Object.assign(methodLengths, extra.methodLengths);
  return methodLengths;
}

function inheritedPromiseOps(
  chain: WebIdlRuntimeInterface[],
  extra: Omit<Partial<InterfaceMeta>, "name">,
): string[] {
  const promiseOps = new Set<string>(extra.promiseOps);
  for (const entry of chain) {
    for (const op of entry.promiseOps ?? []) promiseOps.add(op);
  }
  return [...promiseOps];
}

export function idlInterfaceMeta(
  name: IdlInterfaceName,
  extra: Omit<Partial<InterfaceMeta>, "name"> = {},
): InterfaceMeta {
  const chain = inheritedInterfaceChain(name);
  const own: WebIdlRuntimeInterface = WEBIDL_RUNTIME[name];
  return {
    length: own.length,
    ...extra,
    name,
    constants: { ...own.constants, ...extra.constants },
    methodLengths: inheritedMethodLengths(chain, extra),
    staticMethodLengths: { ...own.staticMethodLengths, ...extra.staticMethodLengths },
    promiseOps: inheritedPromiseOps(chain, extra),
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

function shouldCopyGeneratedProperty(key: PropertyKey): boolean {
  return key !== "name" && key !== "length" && key !== "prototype";
}

function copyGeneratedStaticProperties(implementation: any, exposed: any): void {
  for (const key of Reflect.ownKeys(implementation)) {
    if (!shouldCopyGeneratedProperty(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(implementation, key);
    if (descriptor) Object.defineProperty(exposed, key, descriptor);
  }
}

function linkGeneratedPrototype(implementation: any, exposed: any): void {
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
}

function generatedInterfaceObject(implementation: any, constructible: boolean): any {
  const exposed = function (this: any) {
    if (!constructible || !new.target) throw new TypeError("Illegal constructor");
    return Reflect.construct(implementation, Array.from(arguments), new.target);
  };
  copyGeneratedStaticProperties(implementation, exposed);
  linkGeneratedPrototype(implementation, exposed);
  return exposed;
}

function wrapGeneratedInterfaces(
  globals: Record<string, any>,
  interfaces: readonly GeneratedInterfaceMeta[],
): void {
  for (const meta of interfaces) {
    const implementation = globals[meta.name];
    if (!isGeneratedConstructor(implementation)) continue;
    globals[meta.name] = generatedInterfaceObject(implementation, meta.constructible);
  }
}

function isGeneratedConstructor(value: any): boolean {
  return typeof value === "function" && !!value.prototype;
}

function generatedInterfaceOptions(
  globals: Record<string, any>,
  meta: GeneratedInterfaceMeta,
): InterfaceMeta {
  const parent = meta.parent ? globals[meta.parent] : undefined;
  return {
    name: meta.name,
    length: meta.length,
    ...(parent ? { parent } : {}),
    methodLengths: { ...meta.methodLengths },
    staticMethodLengths: { ...meta.staticMethodLengths },
    brandOps: true,
    brandAttrs: true,
  };
}

function finalizeGeneratedInterfaceMetadata(
  globals: Record<string, any>,
  interfaces: readonly GeneratedInterfaceMeta[],
): void {
  for (const meta of interfaces) {
    const constructor = globals[meta.name];
    if (!isGeneratedConstructor(constructor)) continue;
    finalizeInterface(constructor, generatedInterfaceOptions(globals, meta));
  }
}

function copyParentStaticMethods(
  constructor: any,
  meta: GeneratedInterfaceMeta,
  globals: Record<string, any>,
  byName: Map<string, GeneratedInterfaceMeta>,
): void {
  let parent = meta.parent ? byName.get(meta.parent) : undefined;
  while (parent) {
    const parentInterface = globals[parent.name];
    copyParentStaticMethodsFromInterface(constructor, parentInterface, parent.staticMethodLengths);
    parent = parent.parent ? byName.get(parent.parent) : undefined;
  }
}

function copyParentStaticMethodsFromInterface(
  constructor: any,
  parentInterface: any,
  staticMethodLengths: Readonly<Record<string, number>>,
): void {
  for (const name of Object.keys(staticMethodLengths)) {
    if (hasOwn.call(constructor, name)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(parentInterface, name);
    if (descriptor) Object.defineProperty(constructor, name, descriptor);
  }
}

function inheritGeneratedStaticMethods(
  globals: Record<string, any>,
  interfaces: readonly GeneratedInterfaceMeta[],
): void {
  const byName = new Map(interfaces.map((meta) => [meta.name, meta]));
  for (const meta of interfaces) {
    const constructor = globals[meta.name];
    if (!isGeneratedConstructor(constructor)) continue;
    copyParentStaticMethods(constructor, meta, globals, byName);
  }
}

function finalizeGeneratedIterable(
  constructor: any,
  iterable: GeneratedInterfaceMeta["iterable"],
): void {
  if (iterable === "pair") {
    Object.defineProperty(constructor.prototype, Symbol.iterator, {
      value: constructor.prototype.entries,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    return;
  }
  if (iterable !== "value") return;
  for (const name of ["entries", "keys", "values", "forEach"] as const) {
    Object.defineProperty(constructor.prototype, name, {
      value: Array.prototype[name],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  Object.defineProperty(constructor.prototype, Symbol.iterator, {
    value: Array.prototype[Symbol.iterator],
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

function finalizeGeneratedIterables(
  globals: Record<string, any>,
  interfaces: readonly GeneratedInterfaceMeta[],
): void {
  for (const meta of interfaces) {
    const constructor = globals[meta.name];
    if (!isGeneratedConstructor(constructor)) continue;
    finalizeGeneratedIterable(constructor, meta.iterable);
  }
}

export function finalizeGeneratedInterfaces(
  globals: Record<string, any>,
  interfaces: readonly GeneratedInterfaceMeta[],
): void {
  wrapGeneratedInterfaces(globals, interfaces);
  finalizeGeneratedInterfaceMetadata(globals, interfaces);
  inheritGeneratedStaticMethods(globals, interfaces);
  finalizeGeneratedIterables(globals, interfaces);
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
