// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Web Storage outlives this isolate, which holds one document: the engine keeps each origin's
// areas (engine state/web-storage.ts), and the page works on copies that send their changes back.

import type { WebStorageOp } from "@kitesurf/jsrpc-types/page-script";
import { NativePromise } from "./native-scheduling.ts";

export interface StorageArea {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  clear(): void;
  keys(): readonly string[]; // insertion order, which a later set of the same key keeps
}

// The spec leaves the per-origin quota to the implementation; browsers allow 5 MiB of UTF-16
// code units, keys and values together, and so do we.
const QUOTA_UNITS = 5 * 1024 * 1024;

export function memoryArea(): StorageArea {
  const data = new Map<string, string>();
  let keys: readonly string[] | null = null; // until a key comes or goes
  return {
    get: (k) => data.get(k) ?? null,
    set: (k, v) => {
      if (!data.has(k)) keys = null;
      data.set(k, v);
    },
    remove: (k) => {
      if (data.delete(k)) keys = null;
    },
    clear: () => {
      data.clear();
      keys = null;
    },
    keys: () => (keys ??= Array.from(data.keys())),
  };
}

function quotaExceeded(key: string): DOMException {
  return new DOMException(
    `Setting the value of '${key}' exceeded the quota.`,
    "QuotaExceededError",
  );
}

/** Storage on an http(s) page: a copy of the origin's area (`seed`) that sends each change to
 * the engine, batched per microtask, so other documents see it from their next navigate on. */
export function sharedArea(
  seed: Array<[string, string]>,
  send: (ops: WebStorageOp[]) => void,
): StorageArea {
  const data = new Map(seed);
  let keys: readonly string[] | null = null; // until a key comes or goes
  let used = 0;
  for (const [k, v] of data) used += k.length + v.length;
  // Only the last value (null: removal) per key, behind a clear, so a batch never holds more
  // than the quota: one over the RPC size cap would be refused, losing every write in it.
  let pending: Map<string, string | null> | null = null;
  let cleared = false;
  const batch = (): Map<string, string | null> => {
    if (pending) return pending;
    const next = new Map<string, string | null>();
    pending = next;
    void NativePromise.resolve().then(() => {
      const ops: WebStorageOp[] = cleared ? [{ op: "clear" }] : [];
      for (const [key, value] of next) {
        ops.push(value === null ? { op: "remove", key } : { op: "set", key, value });
      }
      pending = null;
      cleared = false;
      send(ops);
    });
    return next;
  };
  return {
    get: (k) => data.get(k) ?? null,
    set(k, v) {
      const old = data.get(k);
      const next = used - (old === undefined ? 0 : k.length + old.length) + k.length + v.length;
      if (next > QUOTA_UNITS) throw quotaExceeded(k);
      if (old === undefined) keys = null;
      data.set(k, v);
      used = next;
      batch().set(k, v);
    },
    // Sent even when this copy lacks the key: another page may have written it to the engine's
    // area after this copy was taken.
    remove(k) {
      const old = data.get(k);
      if (old !== undefined) {
        data.delete(k);
        keys = null;
        used -= k.length + old.length;
      }
      batch().set(k, null);
    },
    clear() {
      data.clear();
      keys = null;
      used = 0;
      batch().clear();
      cleared = true;
    },
    keys: () => (keys ??= Array.from(data.keys())),
  };
}

// Captured at load, before page code runs: a page that replaces Reflect, Proxy or WeakMap must
// not change what its storage does.
const { defineProperty, deleteProperty, get, getOwnPropertyDescriptor, getPrototypeOf } = Reflect;
const { has, ownKeys, set } = Reflect;
const hasOwn = Object.hasOwn;
const NativeProxy = Proxy;
const areas = new WeakMap<object, StorageArea>();

function areaOf(self: unknown, member: string): StorageArea {
  const area = typeof self === "object" && self !== null ? areas.get(self) : undefined;
  if (area === undefined) {
    throw new TypeError(`Failed to execute '${member}' on 'Storage': Illegal invocation`);
  }
  return area;
}

function needArgs(given: number, needed: number, member: string): void {
  if (given >= needed) return;
  const what = `${needed} argument${needed === 1 ? "" : "s"} required, but only ${given} present.`;
  throw new TypeError(`Failed to execute '${member}' on 'Storage': ${what}`);
}

const domString = (value: string): string => `${value}`; // ToString: a Symbol throws

/** The HTML Storage interface: not constructible, its members on the prototype as WebIDL lays
 * them out, enumerable and brand-checked against the areas storageObject made. */
export class Storage {
  constructor() {
    throw new TypeError("Illegal constructor");
  }
}
const members = {
  key(index: number): string | null {
    const area = areaOf(this, "key");
    needArgs(arguments.length, 1, "key");
    const keys = area.keys();
    const i = index >>> 0; // WebIDL unsigned long: modulo 2^32, so -1 is out of range
    return i < keys.length ? (keys[i] ?? null) : null;
  },
  getItem(key: string): string | null {
    const area = areaOf(this, "getItem");
    needArgs(arguments.length, 1, "getItem");
    return area.get(domString(key));
  },
  setItem(key: string, value: string): void {
    const area = areaOf(this, "setItem");
    needArgs(arguments.length, 2, "setItem");
    area.set(domString(key), domString(value));
  },
  removeItem(key: string): void {
    const area = areaOf(this, "removeItem");
    needArgs(arguments.length, 1, "removeItem");
    area.remove(domString(key));
  },
  clear(): void {
    areaOf(this, "clear").clear();
  },
};
const lengthAccessor = getOwnPropertyDescriptor(
  {
    get length(): number {
      return areaOf(this, "length").keys().length;
    },
  },
  "length",
);
defineProperty(Storage.prototype, "length", {
  get: lengthAccessor?.get,
  enumerable: true,
  configurable: true,
});
for (const [name, value] of Object.entries(members)) {
  defineProperty(Storage.prototype, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}
defineProperty(Storage.prototype, Symbol.toStringTag, { value: "Storage", configurable: true });

// WebIDL's named properties without [LegacyOverrideBuiltIns]: a stored key shows as a property
// unless the prototype chain has that name (`length`, `key`), which still reads the built-in.
function visible(target: object, area: StorageArea, name: string): boolean {
  if (area.get(name) === null) return false;
  for (let proto = getPrototypeOf(target); proto !== null; proto = getPrototypeOf(proto)) {
    if (hasOwn(proto, name)) return false;
  }
  return true;
}

/** A Storage over `area`, behaving like a browser's: stored keys are its enumerable own
 * properties, and a named get, set, `in` or delete reads or writes the area. */
export function storageObject(area: StorageArea): object {
  const target: object = Object.create(Storage.prototype);
  const proxy = new NativeProxy(target, {
    get: (t, p, receiver) =>
      typeof p === "string" && visible(t, area, p) ? area.get(p) : get(t, p, receiver),
    // The named setter takes every string, shadowed or not: `storage.key = v` stores "key", and
    // `storage.key` still reads the method.
    set: (t, p, v, receiver) => {
      if (typeof p !== "string" || receiver !== proxy) return set(t, p, v, receiver);
      area.set(p, domString(v));
      return true;
    },
    has: (t, p) => (typeof p === "string" && visible(t, area, p)) || has(t, p),
    deleteProperty: (t, p) => {
      if (typeof p !== "string" || !visible(t, area, p)) return deleteProperty(t, p);
      area.remove(p);
      return true;
    },
    getOwnPropertyDescriptor: (t, p) => {
      if (typeof p !== "string" || !visible(t, area, p)) return getOwnPropertyDescriptor(t, p);
      return { value: area.get(p), writable: true, enumerable: true, configurable: true };
    },
    defineProperty: (t, p, desc) => {
      if (typeof p !== "string") return defineProperty(t, p, desc);
      if (!("value" in desc) && !("writable" in desc)) return false; // only data reaches the setter
      area.set(p, domString(desc.value));
      return true;
    },
    ownKeys: (t) => [...area.keys().filter((k) => visible(t, area, k)), ...ownKeys(t)],
    preventExtensions: () => false,
  });
  areas.set(proxy, area);
  return proxy;
}
