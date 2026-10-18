// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// When the event loop handed the engine a client message: a request that waited before its
// handler ran shows that wait as arrival-to-handler time instead of vanishing between spans.
const arrivals = new WeakMap<object, number>();

export function markArrival(req: object, at: number): void {
  arrivals.set(req, at);
}

/** Returns the request arrival timestamp in epoch milliseconds, or `undefined` if unmarked. */
export function arrivalOf(req: object): number | undefined {
  return arrivals.get(req);
}
