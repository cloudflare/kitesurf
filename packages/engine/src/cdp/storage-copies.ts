// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The localStorage copies open pages hold. The engine's area (state/local-storage.ts) is the
// record: every change lands there first and then goes to each other open copy of the origin, so
// the copies stay in step and fire `storage`.

import type { LocalStorageOp } from "@kitesurf/jsrpc-types/page-script";
import type { DispatchCtx } from "./dispatch.ts";
import type { TargetState } from "./types.ts";
import type { PageScriptStub } from "../eval/page-script.ts";
import type { LocalStorage, LocalStorageApplied } from "../state/local-storage.ts";

/** One document's copy of an origin's area. */
export class StorageCopy {
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
}

const copies = new WeakMap<LocalStorage, Set<StorageCopy>>();

function registerCopy(copy: StorageCopy): void {
  let set = copies.get(copy.storage);
  if (!set) copies.set(copy.storage, (set = new Set()));
  for (const c of set) if (!c.live) set.delete(c);
  set.add(copy);
}

function liveCopies(storage: LocalStorage, origin: string): StorageCopy[] {
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
