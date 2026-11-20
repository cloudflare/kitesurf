// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The localStorage copies open pages hold. The engine's area (state/local-storage.ts) is the
// record: every change lands there first and then goes to each other open copy of the origin, so
// the copies stay in step and fire `storage`. DOMStorage reads and writes through here too.

import type { Protocol } from "devtools-protocol";
import type { LocalStorageOp } from "@kitesurf/jsrpc-types/page-script";
import type { DispatchCtx } from "./dispatch.ts";
import type { FrameState, TargetState } from "./types.ts";
import type { PageScriptStub } from "../eval/page-script.ts";
import {
  LOCAL_STORAGE_AREA_LIMIT_UNITS,
  LOCAL_STORAGE_QUOTA_UNITS,
  localStorageOrigin,
  type LocalStorage,
  type LocalStorageApplied,
  type LocalStorageChange,
} from "../state/local-storage.ts";
import { localStorageForTarget } from "./target.ts";

/** One document's copy of an origin's area. */
export class StorageCopy {
  #applied = 0;
  #waiters: Array<{ seq: number; resolve: () => void }> = [];

  constructor(
    readonly targets: ReadonlyMap<string, TargetState>,
    readonly target: TargetState,
    readonly generation: number,
    readonly stub: PageScriptStub,
    readonly storage: LocalStorage,
    readonly origin: string,
    readonly url: string,
  ) {}

  /**
   * Register the copy and send the page its seed. Later changes reach the copy from this call
   * on. What fits SEED_INLINE_BYTES returns for the navigate call; the rest goes ahead in chunks.
   */
  async seed(): Promise<Array<[string, string]>> {
    registerCopy(this);
    const chunks = seedChunks(this.storage.entries(this.origin));
    const inline = chunks.pop() ?? [];
    for (const entries of chunks) await this.stub.webStorage({ op: "seed", entries });
    return inline;
  }

  get live(): boolean {
    return (
      this.targets.get(this.target.targetId) === this.target &&
      this.target.navigateGeneration === this.generation
    );
  }

  /** The last batch of this page the engine applied. */
  get applied(): number {
    return this.#applied;
  }

  /** The page's batch `seq` was applied. */
  received(seq: number): void {
    if (seq > this.#applied) this.#applied = seq;
    this.#waiters = this.#waiters.filter((w) => {
      if (w.seq > this.#applied) return true;
      w.resolve();
      return false;
    });
  }

  /** Resolves once batch `seq` was applied, or after `ms`. */
  settled(seq: number, ms: number): Promise<void> {
    if (seq <= this.#applied) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = { seq, resolve };
      this.#waiters.push(waiter);
      setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        resolve();
      }, ms);
    });
  }
}

// JSRPC rejects a message past 32 MiB (core dom/cdp.rs), and per-entry framing, not the text,
// dominates an area of many short keys. The navigate call carries the document too, so its seed
// stays small. A string serializes to at most two bytes per code unit.
const SEED_INLINE_BYTES = 1024 * 1024;
const SEED_CHUNK_BYTES = 8 * 1024 * 1024;
const SEED_ENTRY_BYTES = 32;

// The entries in chunks under SEED_CHUNK_BYTES; the last one, sent inline, under SEED_INLINE_BYTES.
function seedChunks(entries: Array<[string, string]>): Array<Array<[string, string]>> {
  const chunks: Array<Array<[string, string]>> = [];
  let chunk: Array<[string, string]> = [];
  let bytes = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const size = SEED_ENTRY_BYTES + 2 * (entry[0].length + entry[1].length);
    const budget = chunks.length === 0 ? SEED_INLINE_BYTES : SEED_CHUNK_BYTES;
    if (chunk.length > 0 && bytes + size > budget) {
      chunks.push(chunk.reverse());
      chunk = [];
      bytes = 0;
    }
    chunk.push(entry);
    bytes += size;
  }
  if (chunk.length > 0 || chunks.length === 0) chunks.push(chunk.reverse());
  return chunks.reverse();
}

const copies = new WeakMap<LocalStorage, Set<StorageCopy>>();

function registerCopy(copy: StorageCopy): void {
  let set = copies.get(copy.storage);
  if (!set) copies.set(copy.storage, (set = new Set()));
  for (const c of set) if (!c.live) set.delete(c);
  set.add(copy);
}

export function liveCopies(storage: LocalStorage, origin: string): StorageCopy[] {
  const out: StorageCopy[] = [];
  const set = copies.get(storage);
  for (const c of set ?? []) {
    if (!c.live) set?.delete(c);
    else if (c.origin === origin) out.push(c);
  }
  return out;
}

// Change an origin's area and send the change to every other open copy, with `storage` events
// unless `url` is null. `source`, whose batch `seq` it is, gets an ack with the area's value for
// each set the area dropped. Its page checked the quota; any other change must fit it here.
// Resolves once every copy has the change.
export async function changeLocalStorage(
  ctx: DispatchCtx,
  storage: LocalStorage,
  origin: string,
  ops: readonly LocalStorageOp[],
  from: { source?: StorageCopy; seq?: number; url: string | null },
): Promise<LocalStorageApplied> {
  const source = from.source;
  const limit = source ? LOCAL_STORAGE_AREA_LIMIT_UNITS : LOCAL_STORAGE_QUOTA_UNITS;
  const result = storage.apply(origin, ops, limit);
  source?.received(from.seq ?? 0);
  emitChanges(ctx, storage, origin, result.changes);
  const pushes: Promise<unknown>[] = [];
  for (const copy of liveCopies(storage, origin)) {
    if (copy === source) pushes.push(pushTo(copy, dropped(storage, origin, ops, result), null));
    else if (result.applied.length > 0) pushes.push(pushTo(copy, result.applied, from.url));
  }
  await Promise.all(pushes);
  return result;
}

// `seq` tells the page which of its own batches the area held before these ops, so it replays
// the rest on top (page-script web-storage.ts).
function pushTo(copy: StorageCopy, ops: LocalStorageOp[], url: string | null): Promise<unknown> {
  const params = { op: "apply", area: "local", ops, url, seq: copy.applied } as const;
  return copy.stub.webStorage(params).catch(() => {});
}

// The area's value for each key whose set it dropped, which the source's copy already holds.
function dropped(
  storage: LocalStorage,
  origin: string,
  ops: readonly LocalStorageOp[],
  result: LocalStorageApplied,
): LocalStorageOp[] {
  const applied = new Set(result.applied);
  const keys = new Set<string>();
  for (const op of ops) if (op.op === "set" && !applied.has(op)) keys.add(op.key);
  if (keys.size === 0) return [];
  const area = new Map(storage.entries(origin));
  return Array.from(keys, (key): LocalStorageOp => {
    const value = area.get(key);
    return value === undefined ? { op: "remove", key } : { op: "set", key, value };
  });
}

export function storageIdFor(
  origin: string,
  isLocalStorage: boolean,
): Protocol.DOMStorage.StorageId {
  return { securityOrigin: origin, storageKey: `${origin}/`, isLocalStorage };
}

export function documentOrigin(target: TargetState): string | null {
  return localStorageOrigin(target.pageScriptUrl ?? target.url);
}

function sessionOrigin(target: TargetState, frame: FrameState | null): string | null {
  if (!frame) return documentOrigin(target);
  if (frame.detached || target.frames.get(frame.frameId) !== frame) return null;
  return localStorageOrigin(frame.pageScriptUrl ?? frame.url);
}

// DOMStorage events go to the sessions that enabled the domain on a page or frame of the origin,
// as in Chrome, which reports the areas of the documents a session shows.
function emitChanges(
  ctx: DispatchCtx,
  storage: LocalStorage,
  origin: string,
  changes: readonly LocalStorageChange[],
): void {
  if (changes.length === 0) return;
  const storageId = storageIdFor(origin, true);
  for (const target of ctx.browser.targets.values()) {
    if (target.domStorageSessions.size === 0) continue;
    if (localStorageForTarget(ctx, target) !== storage) continue;
    for (const [sessionId, frame] of target.domStorageSessions) {
      if (sessionOrigin(target, frame) !== origin) continue;
      for (const change of changes) {
        if (change.op === "clear") {
          ctx.emit({
            method: "DOMStorage.domStorageItemsCleared",
            params: { storageId },
            sessionId,
          });
        } else if (change.op === "remove") {
          const params = { storageId, key: change.key };
          ctx.emit({ method: "DOMStorage.domStorageItemRemoved", params, sessionId });
        } else if (change.oldValue === null) {
          const params = { storageId, key: change.key, newValue: change.value };
          ctx.emit({ method: "DOMStorage.domStorageItemAdded", params, sessionId });
        } else {
          const params = {
            storageId,
            key: change.key,
            oldValue: change.oldValue,
            newValue: change.value,
          };
          ctx.emit({ method: "DOMStorage.domStorageItemUpdated", params, sessionId });
        }
      }
    }
  }
}
