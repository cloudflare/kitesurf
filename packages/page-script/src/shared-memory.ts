// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Detects shared-memory values nested in worker messages before structured cloning.

function isUnseenObject(item: unknown, seen: Set<object>): item is object {
  return typeof item === "object" && item !== null && !seen.has(item);
}

function appendMapItems(item: Map<unknown, unknown>, stack: unknown[]): void {
  for (const [key, entry] of item) stack.push(key, entry);
}

function appendSetItems(item: Set<unknown>, stack: unknown[]): void {
  for (const entry of item) stack.push(entry);
}

function appendObjectItems(item: object, stack: unknown[]): void {
  for (const entry of Object.values(item)) stack.push(entry);
}

function appendContainerItems(item: object, stack: unknown[]): boolean {
  if (ArrayBuffer.isView(item)) return item.buffer instanceof SharedArrayBuffer;
  if (item instanceof ArrayBuffer) return false;
  if (item instanceof Map) {
    appendMapItems(item, stack);
    return false;
  }
  if (item instanceof Set) {
    appendSetItems(item, stack);
    return false;
  }
  appendObjectItems(item, stack);
  return false;
}

function isSharedValue(item: object, stack: unknown[]): boolean {
  return item instanceof SharedArrayBuffer || appendContainerItems(item, stack);
}

export function holdsSharedMemory(value: unknown): boolean {
  if (typeof SharedArrayBuffer !== "function") return false;
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!isUnseenObject(item, seen)) continue;
    seen.add(item);
    if (isSharedValue(item, stack)) return true;
  }
  return false;
}
