// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Coalesces slot-assignment checks and dispatches trusted events when assigned nodes change.

import { dom, nodeFor } from "../state.js";
import { KsEvent } from "./event.js";
import { dispatchTrustedOnKey } from "./dispatch.js";

const snapshots: Map<number, string> = new Map();
const pendingRoots: Set<number> = new Set();
let scheduled = false;

function affectedRoot(nodeId: number): number {
  try {
    if (dom.shadowHostId(nodeId) >= 0) return nodeId;
    const asHost = dom.shadowRootId(nodeId);
    if (asHost >= 0) return asHost;
    return dom.containingShadowRootId(nodeId);
  } catch {
    return -1;
  }
}

/**
 * Queues a microtask scan for the affected root.
 * `slotchange` fires only when assigned-node IDs change.
 */
export function maybeScheduleSlotchange(nodeId: number): void {
  if (nodeId == null || nodeId < 0) return;
  const rootId = affectedRoot(nodeId);
  if (rootId < 0) return;
  pendingRoots.add(rootId);
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(scanPendingRoots);
}

function scanPendingRoots(): void {
  scheduled = false;
  const roots = Array.from(pendingRoots);
  pendingRoots.clear();
  for (const rootId of roots) {
    let slotIds: number[];
    try {
      slotIds = Array.from(dom.querySelectorAllInSubtree(rootId, "slot"));
    } catch {
      continue;
    }
    for (const slotId of slotIds) {
      let assigned: number[];
      try {
        assigned = Array.from(dom.assignedNodesOf(slotId));
      } catch {
        continue;
      }
      const key = assigned.join(",");
      const prev = snapshots.get(slotId) ?? "";
      if (key === prev) continue;
      snapshots.set(slotId, key);
      const slot = nodeFor(slotId);
      if (!slot || typeof slot.dispatchEvent !== "function") {
        snapshots.delete(slotId);
        continue;
      }
      try {
        dispatchTrustedOnKey(
          slotId,
          new KsEvent("slotchange", {
            bubbles: true,
            cancelable: false,
          }),
        );
      } catch {}
    }
  }
}
