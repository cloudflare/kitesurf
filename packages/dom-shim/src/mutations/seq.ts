// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Tracks DOM and paint mutation sequences and runs post-mutation hooks.

import { getInternalState } from "../internal-state.js";
import { adoptedWrapperIds, liveWrapper, postMutationHooks } from "../registries.js";

/** Mutation categories let post-mutation hooks skip unrelated caches and work. */
export type MutationHint =
  | "text"
  | "data"
  | "paint"
  | "style"
  | { attribute: string; node?: number };

/** Advances mutation sequences, invalidates caches, and runs post-mutation hooks. */
export function bumpMutationSeq(hint?: MutationHint, attrsUnchanged = false): void {
  const cs = getInternalState();
  const v = (cs.mutationSeq | 0) + 1;
  cs.mutationSeq = v;
  if (hint === "paint") cs.paintNeutralSeq = (cs.paintNeutralSeq | 0) + 1;
  else cs.treeSeq = (cs.treeSeq | 0) + 1;
  if (typeof hint === "object" && typeof hint.node === "number") {
    const wrapper = liveWrapper(hint.node);
    if (wrapper) wrapper._attrFlatCache = null;
    else if (adoptedWrapperIds.has(hint.node)) cs.attrSeq = (cs.attrSeq | 0) + 1;
  } else if (
    hint !== "text" &&
    hint !== "data" &&
    hint !== "paint" &&
    hint !== "style" &&
    !attrsUnchanged
  ) {
    cs.attrSeq = (cs.attrSeq | 0) + 1;
  }
  if (typeof hint !== "object" && hint !== "data" && hint !== "paint" && hint !== "style") {
    cs.childSeq = (cs.childSeq | 0) + 1;
  }
  cs.lastMutationAt = Date.now();
  for (const h of postMutationHooks) {
    try {
      h(hint);
    } catch {}
  }
}

export function markDamageNode(nodeId: number): void {
  if (!Number.isFinite(nodeId) || nodeId < 0) return;
  const cs = getInternalState();
  cs.damageNodes.add(nodeId | 0);
}
