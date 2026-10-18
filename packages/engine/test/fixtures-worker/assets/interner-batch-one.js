// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Batch one of the interner-reclaim pair: deliberately shares every
// local identifier name with batch two (see boa-interner-reclaim e2e).
const kitesurfInternerProbeLocal = 40;
const anotherSharedIdentifierName = 2;
export const value = kitesurfInternerProbeLocal + anotherSharedIdentifierName;
export const tag = "batch-one";
export function probe() {
  return "one-alive";
}
