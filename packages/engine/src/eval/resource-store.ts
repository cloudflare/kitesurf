// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Stores image and font bytes behind connection-scoped resource keys for rendering.

import {
  MEMORY_STORE_LIMITS,
  isStoredBytes,
  type SessionStore,
  type StoreTable,
} from "../state/session-store.ts";

export const ENGINE_KEY_MARKER = 1n << 63n;

export const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

const MAX_TOTAL_BYTES = MEMORY_STORE_LIMITS.imageBytes;

const MAX_TOTAL_FONT_BYTES = MEMORY_STORE_LIMITS.fontBytes;

const MAX_FONT_ENTRIES = 256;

const PER_ENTRY_OVERHEAD_BYTES = 200;

type ResourceKind = "image" | "font";

interface Entry {
  bytes: Uint8Array;
  connectionId: string;
  targetId: string;
}

interface Owner {
  bytes: number;
  /** Entry ids in least-recently-read order. */
  ids: Set<string>;
}

const stores: Record<ResourceKind, Map<string, Entry>> = {
  image: new Map(),
  font: new Map(),
};
const owners: Record<ResourceKind, Map<string, Owner>> = {
  image: new Map(),
  font: new Map(),
};
const bytesTotal: Record<ResourceKind, number> = { image: 0, font: 0 };

// A session whose store is off the heap keeps its payloads there, under its own budget. Only an
// index of ids, sizes and targets stays in memory, least recently read first.
class OffHeapResources {
  readonly #bytes: StoreTable<Uint8Array>;
  readonly #limit: Record<ResourceKind, number>;
  readonly #index: Record<ResourceKind, Map<string, { size: number; targetId: string }>> = {
    image: new Map(),
    font: new Map(),
  };
  readonly #total: Record<ResourceKind, number> = { image: 0, font: 0 };

  constructor(store: SessionStore) {
    this.#bytes = store.table("resources", isStoredBytes);
    this.#limit = { image: store.limits.imageBytes, font: store.limits.fontBytes };
  }

  put(kind: ResourceKind, id: string, bytes: Uint8Array, targetId: string): boolean {
    if (bytes.byteLength > this.#limit[kind]) return false;
    this.#bytes.set(id, bytes);
    const index = this.#index[kind];
    index.set(id, { size: bytes.byteLength, targetId });
    this.#total[kind] += bytes.byteLength;
    for (const oldest of Array.from(index.keys())) {
      if (this.#total[kind] <= this.#limit[kind]) break;
      this.drop(kind, oldest);
    }
    return true;
  }

  get(kind: ResourceKind, id: string): Uint8Array | null {
    const entry = this.#index[kind].get(id);
    if (!entry) return null;
    this.#index[kind].delete(id);
    this.#index[kind].set(id, entry);
    return this.#bytes.get(id) ?? null;
  }

  drop(kind: ResourceKind, id: string): void {
    const entry = this.#index[kind].get(id);
    if (!entry) return;
    this.#total[kind] -= entry.size;
    this.#index[kind].delete(id);
    this.#bytes.delete(id);
  }

  dropTarget(targetId: string): void {
    for (const kind of ["image", "font"] as const) {
      for (const [id, entry] of Array.from(this.#index[kind])) {
        if (entry.targetId === targetId) this.drop(kind, id);
      }
    }
  }

  clear(): void {
    for (const kind of ["image", "font"] as const) {
      for (const id of Array.from(this.#index[kind].keys())) this.drop(kind, id);
    }
  }
}

const offHeap = new Map<string, OffHeapResources>();

/** Keeps the connection's payloads in its store when that store is off the heap. A store on the
 * heap would only move them out from under the isolate budget that bounds them. */
export function registerResourceStore(connectionId: string, store: SessionStore): void {
  if (!store.limits.onHeap) offHeap.set(connectionId, new OffHeapResources(store));
}

function mintKey(): bigint {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  const raw = (BigInt(words[0]!) << 32n) | BigInt(words[1]!);
  return (raw & (ENGINE_KEY_MARKER - 1n)) | ENGINE_KEY_MARKER;
}

export function putOpaqueImage(
  bytes: Uint8Array,
  connectionId: string,
  targetId: string,
): bigint | null {
  return put(bytes, "image", connectionId, targetId);
}

export function putAuthorFont(
  bytes: Uint8Array,
  connectionId: string,
  targetId: string,
): bigint | null {
  return put(bytes, "font", connectionId, targetId);
}

function put(
  bytes: Uint8Array,
  kind: ResourceKind,
  connectionId: string,
  targetId: string,
): bigint | null {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ENTRY_BYTES) return null;
  const key = mintKey();
  const id = key.toString();
  const session = offHeap.get(connectionId);
  if (session) return session.put(kind, id, bytes, targetId) ? key : null;
  const charge = chargeOf(bytes);
  stores[kind].set(id, { bytes, connectionId, targetId });
  let owner = owners[kind].get(connectionId);
  if (!owner) {
    owner = { bytes: 0, ids: new Set() };
    owners[kind].set(connectionId, owner);
  }
  owner.bytes += charge;
  owner.ids.add(id);
  bytesTotal[kind] += charge;
  evictOverBudget(kind, connectionId, id);
  return key;
}

function chargeOf(bytes: Uint8Array): number {
  return bytes.byteLength + PER_ENTRY_OVERHEAD_BYTES;
}

function drop(kind: ResourceKind, id: string): void {
  const entry = stores[kind].get(id);
  if (!entry) return;
  const charge = chargeOf(entry.bytes);
  bytesTotal[kind] -= charge;
  stores[kind].delete(id);
  const owner = owners[kind].get(entry.connectionId);
  if (!owner) return;
  owner.bytes -= charge;
  owner.ids.delete(id);
  if (owner.ids.size === 0) owners[kind].delete(entry.connectionId);
}

function oldestOf(owner: Owner, keepId: string): string | undefined {
  for (const id of owner.ids) {
    if (id !== keepId) return id;
  }
  return undefined;
}

// The store is shared by every connection in the isolate. The admitting
// connection evicts its own least-recently-read entries first; only then does
// the connection holding the most bytes give one up, so one page's churn
// cannot reclaim the retained payloads of a connection holding less.
function evictionVictim(
  kind: ResourceKind,
  connectionId: string,
  keepId: string,
): string | undefined {
  const own = owners[kind].get(connectionId);
  const mine = own && oldestOf(own, keepId);
  if (mine !== undefined) return mine;
  let largest: Owner | undefined;
  for (const [id, owner] of owners[kind]) {
    if (id !== connectionId && (!largest || owner.bytes > largest.bytes)) largest = owner;
  }
  return largest && oldestOf(largest, keepId);
}

function evictOverBudget(kind: ResourceKind, connectionId: string, keepId: string): void {
  const ceiling = kind === "font" ? MAX_TOTAL_FONT_BYTES : MAX_TOTAL_BYTES;
  const entries = stores[kind];
  const over = (): boolean =>
    bytesTotal[kind] > ceiling || (kind === "font" && entries.size > MAX_FONT_ENTRIES);

  while (over() && entries.size > 1) {
    const victim = evictionVictim(kind, connectionId, keepId);
    if (victim === undefined) break;
    drop(kind, victim);
  }
}

export function getImageBytes(key: bigint, connectionId: string): Uint8Array | null {
  return get(key, "image", connectionId);
}

export function getFontBytes(key: bigint, connectionId: string): Uint8Array | null {
  return get(key, "font", connectionId);
}

function get(key: bigint, kind: ResourceKind, connectionId: string): Uint8Array | null {
  const id = key.toString();
  const session = offHeap.get(connectionId);
  if (session) return session.get(kind, id);
  const entries = stores[kind];
  const entry = entries.get(id);
  // Opaque keys are not authorization; every read must match its connection owner.
  if (!entry || entry.connectionId !== connectionId) return null;
  const owner = owners[kind].get(connectionId);
  owner?.ids.delete(id);
  owner?.ids.add(id);
  return entry.bytes;
}

export function dropTargetImages(connectionId: string, targetId: string): void {
  offHeap.get(connectionId)?.dropTarget(targetId);
  for (const kind of ["image", "font"] as const) {
    for (const [id, entry] of stores[kind]) {
      if (entry.connectionId === connectionId && entry.targetId === targetId) {
        drop(kind, id);
      }
    }
  }
}

export function dropConnectionImages(connectionId: string): void {
  offHeap.get(connectionId)?.clear();
  offHeap.delete(connectionId);
  for (const kind of ["image", "font"] as const) {
    for (const [id, entry] of stores[kind]) {
      if (entry.connectionId === connectionId) drop(kind, id);
    }
  }
}

/** The payloads on the isolate heap. A store off the heap reports its own size. */
export function imageStoreStats(): { bytes: number; count: number } {
  return {
    bytes: bytesTotal.image + bytesTotal.font,
    count: stores.image.size + stores.font.size,
  };
}
