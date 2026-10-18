// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Detects shared-memory values nested in worker messages before structured cloning.

export function holdsSharedMemory(value: unknown): boolean {
  if (typeof SharedArrayBuffer !== "function") return false;
  const seen = new Set<object>();
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item !== "object" || item === null || seen.has(item)) continue;
    seen.add(item);
    if (item instanceof SharedArrayBuffer) return true;
    if (ArrayBuffer.isView(item)) {
      if (item.buffer instanceof SharedArrayBuffer) return true;
      continue;
    }
    if (item instanceof ArrayBuffer) continue;
    if (item instanceof Map) {
      for (const [key, entry] of item) stack.push(key, entry);
      continue;
    }
    if (item instanceof Set) {
      for (const entry of item) stack.push(entry);
      continue;
    }
    for (const entry of Object.values(item)) stack.push(entry);
  }
  return false;
}
