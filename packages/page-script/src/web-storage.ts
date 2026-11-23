// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Where localStorage and sessionStorage keep their data. localStorage is shared by every page of
// the browser context, so no one isolate can hold it: the engine keeps each origin's area (engine
// state/local-storage.ts), hands the page a copy at navigation, and sends other sources' changes.
// It keeps a tab's sessionStorage the same way; an unseeded area stays in the one document.

import type { LocalStorageOp } from "@kitesurf/jsrpc-types/page-script";
import { sendUpstreamEvent } from "./internal-state.js";
import { NativePromise } from "./native-scheduling.ts";

/** One origin's storage area, synchronous like the Web Storage API. */
export interface StorageArea {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  clear(): void;
  keys(): string[];
}

// The spec leaves the per-origin quota to the browser; browsers use 5 MiB of UTF-16 code units,
// and so does the engine's area (LOCAL_STORAGE_QUOTA_UNITS).
const QUOTA_UNITS = 5 * 1024 * 1024;

export function memoryArea(): StorageArea {
  return mapArea(new Map());
}

const areas = new WeakMap<object, StorageArea>();

function areaOf(self: unknown): StorageArea {
  const area = typeof self === "object" && self !== null ? areas.get(self) : undefined;
  if (!area) throw new TypeError("Illegal invocation");
  return area;
}

function requireArgs(method: string, needed: number, present: number): void {
  if (present >= needed) return;
  throw new TypeError(
    `Failed to execute '${method}' on 'Storage': ${needed} argument${needed > 1 ? "s" : ""} ` +
      `required, but only ${present} present.`,
  );
}

/** The Storage interface. Only storageObject makes instances. */
export const StorageInterface = class Storage {
  constructor() {
    throw new TypeError("Illegal constructor");
  }
  get length(): number {
    return areaOf(this).keys().length;
  }
  key(index: unknown): string | null {
    requireArgs("key", 1, arguments.length);
    // WebIDL unsigned long: NaN and the infinities become 0, the rest wraps modulo 2^32.
    const keys = areaOf(this).keys();
    return keys[Number(index) >>> 0] ?? null;
  }
  getItem(key: unknown): string | null {
    requireArgs("getItem", 1, arguments.length);
    return areaOf(this).get(String(key));
  }
  setItem(key: unknown, value: unknown): void {
    requireArgs("setItem", 2, arguments.length);
    const area = areaOf(this);
    area.set(String(key), String(value));
  }
  removeItem(key: unknown): void {
    requireArgs("removeItem", 1, arguments.length);
    areaOf(this).remove(String(key));
  }
  clear(): void {
    areaOf(this).clear();
  }
};
// WebIDL members are enumerable, so a for-in over a Storage lists them after the stored keys.
for (const name of ["length", "key", "getItem", "setItem", "removeItem", "clear"]) {
  const desc = Object.getOwnPropertyDescriptor(StorageInterface.prototype, name);
  if (desc) Object.defineProperty(StorageInterface.prototype, name, { ...desc, enumerable: true });
}
Object.defineProperty(StorageInterface.prototype, Symbol.toStringTag, {
  value: "Storage",
  configurable: true,
});

/**
 * A Storage over `area`. It is a legacy platform object with named properties (WebIDL): stored
 * keys read, write and enumerate as own properties unless the prototype chain has the name.
 */
export function storageObject(area: StorageArea): object {
  const target: object = Object.create(StorageInterface.prototype);
  const visible = (p: string | symbol): p is string =>
    typeof p === "string" && !(p in target) && area.get(p) !== null;
  const storage: object = new Proxy(target, {
    get: (t, p, receiver) => (visible(p) ? area.get(p) : Reflect.get(t, p, receiver)),
    // The named setter runs for any string, even one the prototype has, as in browsers.
    set: (t, p, value, receiver) => {
      if (typeof p !== "string" || receiver !== storage) return Reflect.set(t, p, value, receiver);
      area.set(p, String(value));
      return true;
    },
    has: (t, p) => visible(p) || Reflect.has(t, p),
    deleteProperty: (t, p) => {
      if (!visible(p)) return Reflect.deleteProperty(t, p);
      area.remove(p);
      return true;
    },
    ownKeys: (t) => [...area.keys().filter((k) => !(k in t)), ...Reflect.ownKeys(t)],
    getOwnPropertyDescriptor: (t, p) =>
      visible(p)
        ? { value: area.get(p), writable: true, enumerable: true, configurable: true }
        : Reflect.getOwnPropertyDescriptor(t, p),
    defineProperty: (t, p, desc) => {
      if (typeof p !== "string" || Object.prototype.hasOwnProperty.call(t, p)) {
        return Reflect.defineProperty(t, p, desc);
      }
      if (!("value" in desc) && !("writable" in desc)) return false;
      area.set(p, String(desc.value));
      return true;
    },
    preventExtensions: () => false,
  });
  areas.set(storage, area);
  return storage;
}

function quotaExceeded(key: string): DOMException {
  return new DOMException(
    `Setting the value of '${key}' exceeded the quota.`,
    "QuotaExceededError",
  );
}

// One upstream event must stay under JSRPC's 32 MiB message limit (core dom/cdp.rs), and a string
// serializes to at most two bytes per code unit. A batch flushes early before it passes this
// budget; one op fits in it, since a set over the quota throws and a longer key is never stored.
const BATCH_UNITS = 2 * QUOTA_UNITS;
const OP_UNITS = 16;

/** A change as a `storage` event reports it. A null key is a clear. */
export interface StorageChange {
  key: string | null;
  oldValue: string | null;
  newValue: string | null;
}

// Applies `ops` to `data` and returns what changed: a set to the same value, a remove of a missing
// key and a clear of an empty area change nothing, as for the Web Storage methods.
function applyOps(data: Map<string, string>, ops: readonly LocalStorageOp[]): StorageChange[] {
  const changes: StorageChange[] = [];
  for (const op of ops) {
    if (op.op === "clear") {
      if (data.size > 0) changes.push({ key: null, oldValue: null, newValue: null });
      data.clear();
      continue;
    }
    const oldValue = data.get(op.key) ?? null;
    const newValue = op.op === "set" ? op.value : null;
    if (oldValue === newValue) continue;
    if (newValue === null) data.delete(op.key);
    else data.set(op.key, newValue);
    changes.push({ key: op.key, oldValue, newValue });
  }
  return changes;
}

/** An area the engine can also change: another page's or a CDP client's writes. */
export interface RemoteArea extends StorageArea {
  /** `seq` is this copy's last batch the engine applied before `ops`. */
  applyRemote(ops: readonly LocalStorageOp[], seq: number): StorageChange[];
}

export function sessionArea(): RemoteArea {
  const data = new Map<string, string>();
  return { ...mapArea(data), applyRemote: (ops) => applyOps(data, ops) };
}

function mapArea(data: Map<string, string>): StorageArea {
  return {
    get: (k) => data.get(k) ?? null,
    set: (k, v) => {
      data.set(k, v);
    },
    remove: (k) => {
      data.delete(k);
    },
    clear: () => data.clear(),
    keys: () => Array.from(data.keys()),
  };
}

export interface SharedArea extends RemoteArea {
  /** Send the unsent changes now. Returns the number of the last batch sent. */
  flush(): number;
}

// Storage on a page the engine seeded: a copy of the engine's area for this origin, with every
// change also sent to the engine, batched per microtask. remove and clear are sent even when this
// copy has nothing to drop: the engine's area can hold keys another page wrote since.
export function sharedArea(
  seed: ReadonlyArray<readonly [string, string]>,
  send: (ops: LocalStorageOp[], seq: number) => void = (ops, seq) =>
    sendUpstreamEvent({ event: "kitesurf.localStorage", params: { ops, seq } }),
): SharedArea {
  const data = new Map<string, string>();
  let used = 0;
  for (const [k, v] of seed) {
    if (typeof k !== "string" || typeof v !== "string") continue;
    data.set(k, v);
  }
  const recount = () => {
    used = 0;
    for (const [k, v] of data) used += k.length + v.length;
  };
  recount();
  let pending: LocalStorageOp[] = [];
  let pendingUnits = 0;
  let scheduled = false;
  let seq = 0;
  // Sent batches until the engine acks them: a change it applied before one replays it on top.
  let unacked: Array<{ seq: number; ops: LocalStorageOp[] }> = [];
  const flush = (): number => {
    if (pending.length === 0) return seq;
    const ops = pending;
    pending = [];
    pendingUnits = 0;
    unacked.push({ seq: ++seq, ops });
    send(ops, seq);
    return seq;
  };
  const queue = (op: LocalStorageOp) => {
    const units =
      OP_UNITS + (op.op === "clear" ? 0 : op.key.length) + (op.op === "set" ? op.value.length : 0);
    if (op.op === "clear") {
      // A clear makes every earlier op of the batch moot.
      pending = [];
      pendingUnits = 0;
    } else if (pendingUnits + units > BATCH_UNITS) {
      flush();
    }
    pending.push(op);
    pendingUnits += units;
    if (scheduled) return;
    scheduled = true;
    void NativePromise.resolve().then(() => {
      scheduled = false;
      flush();
    });
  };
  return {
    flush,
    // The engine applied `ops` before this copy's unacked and unsent changes, which replay on top.
    applyRemote(ops, acked) {
      unacked = unacked.filter((batch) => batch.seq > acked);
      const changes = applyOps(data, ops);
      const unsent = [...unacked.flatMap((batch) => batch.ops), ...pending];
      applyOps(data, unsent);
      recount();
      // A change this copy's unsent ones replace never shows, so it fires no event.
      if (unsent.some((op) => op.op === "clear")) return [];
      const replaced = new Set(unsent.flatMap((op) => (op.op === "clear" ? [] : [op.key])));
      return changes.filter((c) => c.key === null || !replaced.has(c.key));
    },
    get: (k) => data.get(k) ?? null,
    set(k, v) {
      const old = data.get(k);
      const next = used - (old === undefined ? 0 : k.length + old.length) + k.length + v.length;
      if (next > QUOTA_UNITS) throw quotaExceeded(k);
      data.set(k, v);
      used = next;
      queue({ op: "set", key: k, value: v });
    },
    remove(k) {
      const old = data.get(k);
      if (old !== undefined) {
        data.delete(k);
        used -= k.length + old.length;
      }
      if (k.length <= QUOTA_UNITS) queue({ op: "remove", key: k });
    },
    clear() {
      data.clear();
      used = 0;
      queue({ op: "clear" });
    },
    keys: () => Array.from(data.keys()),
  };
}
