// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Builds an epoch-millisecond clock from the host's `HOST_CLOCK` hook or `Date.now`.

export interface HostClock {
  timeOrigin: number;
  now(): number;
}

/** Returns an epoch-millisecond clock from `HOST_CLOCK` or `Date.now`. */
export function makeWallClock(env: unknown): () => number {
  const clock = (env as { HOST_CLOCK?: HostClock } | null)?.HOST_CLOCK;
  if (clock && typeof clock.now === "function" && typeof clock.timeOrigin === "number") {
    return () => clock.timeOrigin + clock.now();
  }
  return () => Date.now();
}
