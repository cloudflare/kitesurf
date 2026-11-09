// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Stores image and font bytes behind connection-scoped resource keys for rendering.

export const ENGINE_KEY_MARKER = 1n << 63n;

export const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const MAX_TOTAL_FONT_BYTES = 16 * 1024 * 1024;

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
  const entries = stores[kind];
  const id = key.toString();
  const entry = entries.get(id);
  // Opaque keys are not authorization; every read must match its connection owner.
  if (!entry || entry.connectionId !== connectionId) return null;
  const owner = owners[kind].get(connectionId);
  owner?.ids.delete(id);
  owner?.ids.add(id);
  return entry.bytes;
}

export function dropTargetImages(connectionId: string, targetId: string): void {
  for (const kind of ["image", "font"] as const) {
    for (const [id, entry] of stores[kind]) {
      if (entry.connectionId === connectionId && entry.targetId === targetId) {
        drop(kind, id);
      }
    }
  }
}

export function dropConnectionImages(connectionId: string): void {
  for (const kind of ["image", "font"] as const) {
    for (const [id, entry] of stores[kind]) {
      if (entry.connectionId === connectionId) drop(kind, id);
    }
  }
}

export function imageStoreStats(): { bytes: number; count: number } {
  return {
    bytes: bytesTotal.image + bytesTotal.font,
    count: stores.image.size + stores.font.size,
  };
}
