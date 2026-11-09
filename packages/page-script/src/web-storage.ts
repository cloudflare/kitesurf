// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// localStorage outlives this isolate, which holds one document: the engine keeps each origin's
// area (engine state/web-storage.ts), and the page works on a copy that sends its changes back.

import type { WebStorageOp } from "@kitesurf/jsrpc-types/page-script";
import { NativePromise } from "./native-scheduling.ts";

export interface StorageArea {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  clear(): void;
  keys(): string[];
}

// The spec leaves the per-origin quota to the implementation; browsers allow 5 MiB of UTF-16
// code units, keys and values together, and so do we.
const QUOTA_UNITS = 5 * 1024 * 1024;

export function memoryArea(): StorageArea {
  const data = new Map<string, string>();
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

function quotaExceeded(key: string): DOMException {
  return new DOMException(
    `Setting the value of '${key}' exceeded the quota.`,
    "QuotaExceededError",
  );
}

/** localStorage on an http(s) page: a copy of the origin's area (`seed`) that sends each change
 * to the engine, batched per microtask, so other pages see it from their next navigate on. */
export function sharedArea(
  seed: Array<[string, string]>,
  send: (ops: WebStorageOp[]) => void,
): StorageArea {
  const data = new Map(seed);
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
        used -= k.length + old.length;
      }
      batch().set(k, null);
    },
    clear() {
      data.clear();
      used = 0;
      batch().clear();
      cleared = true;
    },
    keys: () => Array.from(data.keys()),
  };
}
