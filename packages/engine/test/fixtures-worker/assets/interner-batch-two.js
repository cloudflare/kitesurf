// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Batch two: same identifier names as batch one, parsed AFTER the
// interner reclaimed batch one's entries — resolution must not cross.
const kitesurfInternerProbeLocal = 20;
const anotherSharedIdentifierName = 4;
export const value = kitesurfInternerProbeLocal + anotherSharedIdentifierName;
export const tag = "batch-two";
export function probe() {
  return "two-alive";
}
