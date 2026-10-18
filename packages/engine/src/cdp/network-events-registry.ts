// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Stores the NetworkEventTracker for each active CDP connection.

export { NetworkEventTracker } from "./network-events.ts";
import type { NetworkEventTracker } from "./network-events.ts";

const registry = new Map<string, NetworkEventTracker>();

export function registerTracker(connectionId: string, tracker: NetworkEventTracker): void {
  registry.set(connectionId, tracker);
}

export function unregisterTracker(connectionId: string): void {
  registry.delete(connectionId);
}

export function getTracker(connectionId: string): NetworkEventTracker | undefined {
  return registry.get(connectionId);
}

export const CONNECTION_ID_HEADER = "x-kitesurf-connection-id";
export const FRAME_ID_HEADER = "x-kitesurf-frame-id";
