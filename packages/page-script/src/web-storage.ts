// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Where localStorage and sessionStorage keep their data. localStorage is shared by every page of
// the browser context, so no one isolate can hold it: the engine keeps each origin's area (engine
// state/local-storage.ts), hands the page a copy at navigation, and takes the changes back.
// sessionStorage and an unseeded localStorage stay in memory for the isolate's one document.

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

// localStorage on a page the engine seeded: a copy of the browser context's area for this origin,
// with every change also sent to the engine, batched per microtask. remove and clear are sent even
// when this copy has nothing to drop: the engine's area can hold keys another page wrote since.
export function sharedArea(
  seed: ReadonlyArray<readonly [string, string]>,
  send: (ops: LocalStorageOp[]) => void = (ops) =>
    sendUpstreamEvent({ event: "kitesurf.localStorage", params: { ops } }),
): StorageArea {
  const data = new Map<string, string>();
  let used = 0;
  for (const [k, v] of seed) {
    if (typeof k !== "string" || typeof v !== "string") continue;
    data.set(k, v);
  }
  for (const [k, v] of data) used += k.length + v.length;
  let pending: LocalStorageOp[] | null = null;
  const queue = (op: LocalStorageOp) => {
    if (!pending) {
      pending = [];
      void NativePromise.resolve().then(() => {
        const ops = pending ?? [];
        pending = null;
        if (ops.length > 0) send(ops);
      });
    }
    pending.push(op);
  };
  return {
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
      queue({ op: "remove", key: k });
    },
    clear() {
      data.clear();
      used = 0;
      queue({ op: "clear" });
    },
    keys: () => Array.from(data.keys()),
  };
}
