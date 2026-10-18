// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// CSSStyleDeclaration is a Proxy over a bare target: prototype members route
// to the backend, while CSS property names route to the handler.
import type * as Idl from "./idl/types.generated.js";

export interface StyleDeclarationBackend {
  cssText(): string;
  setCssText(text: unknown): void;
  length(): number;
  // An unsigned long already: the prototype's item() converts it.
  item(index: number): string;
  getPropertyValue(property: unknown): string;
  getPropertyPriority(property: unknown): string;
  setProperty(property: unknown, value: unknown, priority: unknown): void;
  removeProperty(property: unknown): string;
  parentRule(): Idl.CSSRule | null;
  names(): Iterator<string>;
}

const backends = new WeakMap<object, StyleDeclarationBackend>();

function backendOf(self: object): StyleDeclarationBackend {
  const backend = backends.get(self);
  if (!backend) throw new TypeError("Illegal invocation");
  return backend;
}

// Only the computed style's handler serves the indexed reads.
export class CSSStyleDeclarationCls implements Idl.CSSStyleDeclaration {
  readonly [index: number]: string;
  constructor() {
    throw new TypeError("Illegal constructor");
  }
  get cssText() {
    return backendOf(this).cssText();
  }
  set cssText(text: string) {
    backendOf(this).setCssText(text);
  }
  get length() {
    return backendOf(this).length();
  }
  // The IDL's unsigned long, converted once for every backend.
  item(index: number) {
    return backendOf(this).item(Number(index) >>> 0);
  }
  getPropertyValue(property: string) {
    return backendOf(this).getPropertyValue(property);
  }
  getPropertyPriority(property: string) {
    return backendOf(this).getPropertyPriority(property);
  }
  // The backends convert the property names and values, so these arguments
  // pass through as the page gave them.
  setProperty(property: string, value: string, priority?: string) {
    backendOf(this).setProperty(property, value, priority);
  }
  removeProperty(property: string) {
    return backendOf(this).removeProperty(property);
  }
  get parentRule() {
    return backendOf(this).parentRule();
  }
  [Symbol.iterator](): Iterator<string> {
    return backendOf(this).names();
  }
}

// What a declaration object answers: CSSStyleDeclaration's members from the
// prototype, and every CSS property (cssFloat, margin-top, ...) from the
// handler.
export type StyleDeclaration = CSSStyleDeclarationCls &
  Idl.CSSStyleProperties &
  Idl.CSSPageDescriptors;

// The target holds page expandos. Reflection traps merge those keys with CSS
// properties; preventExtensions refuses because its live indexed surface
// cannot be represented on a non-extensible target.
export function makeStyleDeclaration(
  backend: StyleDeclarationBackend,
  handler: ProxyHandler<object>,
): StyleDeclaration {
  const target: StyleDeclaration = Object.create(CSSStyleDeclarationCls.prototype);
  const ownsProp = (t: object, prop: PropertyKey) => Object.prototype.hasOwnProperty.call(t, prop);
  const isMember = (t: object, prop: PropertyKey) =>
    typeof prop === "symbol" || prop in CSSStyleDeclarationCls.prototype || ownsProp(t, prop);
  const proxy = new Proxy<StyleDeclaration>(target, {
    ...handler,
    get(t, prop, receiver) {
      if (isMember(t, prop)) return Reflect.get(t, prop, receiver);
      return handler.get ? handler.get(t, prop, receiver) : undefined;
    },
    set(t, prop, value, receiver) {
      if (isMember(t, prop)) return Reflect.set(t, prop, value, receiver);
      return handler.set ? handler.set(t, prop, value, receiver) : false;
    },
    has(t, prop) {
      if (prop in t) return true;
      return handler.has ? handler.has(t, prop) : false;
    },
    deleteProperty(t, prop) {
      if (ownsProp(t, prop) || !handler.deleteProperty) return Reflect.deleteProperty(t, prop);
      return handler.deleteProperty(t, prop);
    },
    ownKeys(t) {
      const keys = handler.ownKeys ? Array.from(handler.ownKeys(t)) : [];
      const seen = new Set(keys);
      for (const key of Reflect.ownKeys(t)) {
        if (!seen.has(key)) keys.push(key);
      }
      return keys;
    },
    getOwnPropertyDescriptor(t, prop) {
      if (ownsProp(t, prop) || !handler.getOwnPropertyDescriptor) {
        return Reflect.getOwnPropertyDescriptor(t, prop);
      }
      return handler.getOwnPropertyDescriptor(t, prop);
    },
    preventExtensions() {
      return false;
    },
  });
  backends.set(proxy, backend);
  backends.set(target, backend);
  return proxy;
}
