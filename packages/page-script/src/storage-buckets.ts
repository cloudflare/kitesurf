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
import { sendUpstreamEvent } from "./internal-state.js";
import { runPageTaskOrQueue } from "./page-tasks.ts";
import { ksEventCtors, state, type ShimEventCtors } from "./state.ts";
import {
  memoryArea,
  sessionArea,
  sharedArea,
  storageObject,
  type RemoteArea,
  type SharedArea,
  type StorageChange,
} from "./web-storage.ts";

type AreaName = "local" | "session";
type Seed = ReadonlyArray<readonly [string, string]>;

// The document's two Storage objects and their areas, for the engine's webStorage calls.
interface Bucket {
  storage: object;
  area: RemoteArea;
}
let localBucket: (Bucket & { area: SharedArea }) | null = null;
let sessionBucket: Bucket | null = null;
// Engine changes that arrived before navigate() built an area, per area: they land on its seed
// once the area exists.
const earlyOps: Record<AreaName, LocalStorageOp[]> = { local: [], session: [] };
// The part of each area's seed the engine sent ahead of navigate, for an area too large to go in
// one call; navigate's own seed follows it.
const seedAhead: Record<AreaName, Array<[string, string]>> = { local: [], session: [] };

function seededArea(name: AreaName, seed: Seed): SharedArea {
  const ahead = seedAhead[name];
  seedAhead[name] = [];
  const event = name === "local" ? "kitesurf.localStorage" : "kitesurf.sessionStorage";
  const area = sharedArea(ahead.length > 0 ? [...ahead, ...seed] : seed, (ops, seq) =>
    sendUpstreamEvent({ event, params: { ops, seq } }),
  );
  area.applyRemote(earlyOps[name], 0);
  earlyOps[name] = [];
  return area;
}

/**
 * The document's localStorage and sessionStorage. Each is shared when the engine seeded it, and
 * in memory for this document otherwise.
 */
export function storageBuckets(
  localSeed: Seed | null,
  sessionSeed: Seed | null,
): {
  localStorage: object;
  sessionStorage: object;
} {
  const session = sessionSeed ? seededArea("session", sessionSeed) : sessionArea();
  sessionBucket = { storage: storageObject(session), area: session };
  let localStorage: object;
  if (localSeed) {
    const area = seededArea("local", localSeed);
    localStorage = storageObject(area);
    localBucket = { storage: localStorage, area };
  } else {
    localStorage = storageObject(memoryArea());
  }
  return { localStorage, sessionStorage: sessionBucket.storage };
}

type StorageEventInit = NonNullable<ConstructorParameters<ShimEventCtors["StorageEvent"]>[1]>;

function fireStorageEvents(
  changes: StorageChange[],
  storageArea: object,
  url: string | null,
): void {
  if (changes.length === 0 || url === null) return;
  // The captured constructor and trusted dispatch: page script can replace both globals.
  const win = state.window;
  const StorageEventConstructor = ksEventCtors.StorageEvent;
  if (!win || typeof StorageEventConstructor !== "function") return;
  runPageTaskOrQueue(() => {
    for (const change of changes) {
      const init = { ...change, url, storageArea: storageArea as StorageEventInit["storageArea"] };
      state.dispatchTrustedEvent(win, new StorageEventConstructor("storage", init));
    }
  });
}

/** The engine's webStorage call. */
export function webStorage(params: WebStorageParams): WebStorageReply {
  if (params.op === "flush") return { seq: localBucket ? localBucket.area.flush() : 0 };
  if (params.op === "seed") {
    for (const entry of params.entries) seedAhead[params.area].push(entry);
    return { seq: 0 };
  }
  if (params.op === "entries") {
    const area = sessionBucket?.area;
    const entries: Array<[string, string]> = [];
    for (const key of area?.keys() ?? []) entries.push([key, area?.get(key) ?? ""]);
    return { seq: 0, entries };
  }
  const bucket = params.area === "local" ? localBucket : sessionBucket;
  if (!bucket) {
    earlyOps[params.area].push(...params.ops);
    return { seq: 0 };
  }
  fireStorageEvents(bucket.area.applyRemote(params.ops, params.seq), bucket.storage, params.url);
  return { seq: 0 };
}
