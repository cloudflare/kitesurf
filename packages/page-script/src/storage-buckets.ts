// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The document's localStorage and sessionStorage, and the engine's webStorage calls on them. The
// areas themselves are in web-storage.ts, which stays free of the page runtime so tests load it.

import type {
  LocalStorageOp,
  WebStorageParams,
  WebStorageReply,
} from "@kitesurf/jsrpc-types/page-script";
import { runPageTaskOrQueue } from "./page-tasks.ts";
import { ksGlobalByKey } from "./state.ts";
import {
  memoryArea,
  sessionArea,
  sharedArea,
  storageObject,
  type RemoteArea,
  type SharedArea,
  type StorageChange,
} from "./web-storage.ts";

// The document's two Storage objects and their areas, for the engine's webStorage calls.
interface Bucket {
  storage: object;
  area: RemoteArea;
}
let localBucket: (Bucket & { area: SharedArea }) | null = null;
let sessionBucket: Bucket | null = null;
// Engine changes that arrived before navigate() built localStorage; they land on the seed.
let earlyLocalOps: LocalStorageOp[] = [];

/**
 * The document's localStorage and sessionStorage. localStorage is shared when the engine seeded
 * it, and in memory for this document otherwise.
 */
export function storageBuckets(seed: ReadonlyArray<readonly [string, string]> | null): {
  localStorage: object;
  sessionStorage: object;
} {
  const session = sessionArea();
  sessionBucket = { storage: storageObject(session), area: session };
  let localStorage: object;
  if (seed) {
    const area = sharedArea(seed);
    area.applyRemote(earlyLocalOps, 0);
    earlyLocalOps = [];
    localStorage = storageObject(area);
    localBucket = { storage: localStorage, area };
  } else {
    localStorage = storageObject(memoryArea());
  }
  return { localStorage, sessionStorage: sessionBucket.storage };
}

function fireStorageEvents(
  changes: StorageChange[],
  storageArea: object,
  url: string | null,
): void {
  if (changes.length === 0 || url === null) return;
  const win = ksGlobalByKey.window ?? globalThis;
  const StorageEventConstructor = ksGlobalByKey.StorageEvent;
  if (typeof StorageEventConstructor !== "function") return;
  const dispatch: unknown = Reflect.get(win as object, "dispatchEvent");
  if (typeof dispatch !== "function") return;
  runPageTaskOrQueue(() => {
    for (const change of changes) {
      const init = { ...change, url, storageArea };
      Reflect.apply(dispatch, win, [Reflect.construct(StorageEventConstructor, ["storage", init])]);
    }
  });
}

/** The engine's webStorage call. */
export function webStorage(params: WebStorageParams): WebStorageReply {
  if (params.op === "flush") return { seq: localBucket ? localBucket.area.flush() : 0 };
  if (params.op === "entries") {
    const area = sessionBucket?.area;
    const entries: Array<[string, string]> = [];
    for (const key of area?.keys() ?? []) entries.push([key, area?.get(key) ?? ""]);
    return { seq: 0, entries };
  }
  const bucket = params.area === "local" ? localBucket : sessionBucket;
  if (!bucket) {
    if (params.area === "local") earlyLocalOps.push(...params.ops);
    return { seq: 0 };
  }
  const acked = params.area === "local" ? params.seq : 0;
  fireStorageEvents(bucket.area.applyRemote(params.ops, acked), bucket.storage, params.url);
  return { seq: 0 };
}
