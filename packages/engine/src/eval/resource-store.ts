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

const stores: Record<ResourceKind, Map<string, Entry>> = {
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
  stores[kind].set(id, { bytes, connectionId, targetId });
  bytesTotal[kind] += chargeOf(bytes);
  evictOverBudget(kind, connectionId, id);
  return key;
}

function chargeOf(bytes: Uint8Array): number {
  return bytes.byteLength + PER_ENTRY_OVERHEAD_BYTES;
}

function drop(kind: ResourceKind, id: string): void {
  const entry = stores[kind].get(id);
  if (!entry) return;
  bytesTotal[kind] -= chargeOf(entry.bytes);
  stores[kind].delete(id);
}

function evictOverBudget(kind: ResourceKind, connectionId: string, keepId: string): void {
  const ceiling = kind === "font" ? MAX_TOTAL_FONT_BYTES : MAX_TOTAL_BYTES;
  const entries = stores[kind];
  const over = (): boolean =>
    bytesTotal[kind] > ceiling || (kind === "font" && entries.size > MAX_FONT_ENTRIES);

  if (kind === "font") {
    while (over() && entries.size > 1) {
      let victim: string | undefined;
      for (const [id, entry] of entries) {
        if (id === keepId) continue;
        if (entry.connectionId === connectionId) {
          victim = id;
          break;
        }
      }
      if (victim === undefined) break;
      drop(kind, victim);
    }
  }

  while (over() && entries.size > 1) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    drop(kind, oldest);
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
  entries.delete(id);
  entries.set(id, entry);
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
