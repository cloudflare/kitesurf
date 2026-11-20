// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The localStorage copies open pages hold. The engine's area (state/local-storage.ts) is the
// record: every change lands there first and then goes to each other open copy of the origin, so
// the copies stay in step and fire `storage`. DOMStorage reads and writes through here too.

import type { Protocol } from "devtools-protocol";
import type { LocalStorageOp } from "@kitesurf/jsrpc-types/page-script";
import type { DispatchCtx } from "./dispatch.ts";
import type { TargetState } from "./types.ts";
import type { PageScriptStub } from "../eval/page-script.ts";
import {
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

  /** The seed for this document. Later changes reach the copy from the moment of this call. */
  seed(): Array<[string, string]> {
    registerCopy(this);
    return this.storage.entries(this.origin);
  }

  get live(): boolean {
    return (
      this.targets.get(this.target.targetId) === this.target &&
      this.target.navigateGeneration === this.generation
    );
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

/**
 * Change an origin's area and send the change to every open copy but `source`'s, which already
 * made it. A null `url` fires no `storage` events. Resolves once every copy has the change.
 */
export async function changeLocalStorage(
  ctx: DispatchCtx,
  storage: LocalStorage,
  origin: string,
  ops: readonly LocalStorageOp[],
  from: { source?: StorageCopy; url: string | null },
): Promise<LocalStorageApplied> {
  const result = storage.apply(origin, ops);
  emitChanges(ctx, storage, origin, result.changes);
  if (result.applied.length === 0) return result;
  const pushes: Promise<unknown>[] = [];
  for (const copy of liveCopies(storage, origin)) {
    if (copy === from.source) continue;
    const params = { op: "apply", area: "local", ops: result.applied, url: from.url } as const;
    pushes.push(copy.stub.webStorage(params).catch(() => {}));
  }
  await Promise.all(pushes);
  return result;
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

// DOMStorage events go to the sessions that enabled the domain on a page of the origin, as in
// Chrome, which reports the areas of the documents a page shows.
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
    if (localStorageForTarget(ctx, target) !== storage || documentOrigin(target) !== origin) {
      continue;
    }
    for (const sessionId of target.domStorageSessions) {
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
