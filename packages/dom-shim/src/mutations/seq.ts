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
  advanceMutationTreeSeq(cs, hint);
  if (isNumericNodeHint(hint)) updateNodeAttributeCache(cs, hint);
  else if (shouldAdvanceAttributeSeq(hint, attrsUnchanged)) cs.attrSeq = (cs.attrSeq | 0) + 1;
  if (shouldAdvanceChildSeq(hint)) cs.childSeq = (cs.childSeq | 0) + 1;
  cs.lastMutationAt = Date.now();
  runPostMutationHooks(hint);
}

function advanceMutationTreeSeq(
  state: ReturnType<typeof getInternalState>,
  hint: MutationHint | undefined,
): void {
  if (hint === "paint") state.paintNeutralSeq = (state.paintNeutralSeq | 0) + 1;
  else state.treeSeq = (state.treeSeq | 0) + 1;
}

function isNumericNodeHint(
  hint: MutationHint | undefined,
): hint is { attribute: string; node: number } {
  return typeof hint === "object" && typeof hint.node === "number";
}

function updateNodeAttributeCache(
  state: ReturnType<typeof getInternalState>,
  hint: { attribute: string; node: number },
): void {
  const wrapper = liveWrapper(hint.node);
  if (wrapper) wrapper._attrFlatCache = null;
  else if (adoptedWrapperIds.has(hint.node)) state.attrSeq = (state.attrSeq | 0) + 1;
}

function shouldAdvanceAttributeSeq(
  hint: MutationHint | undefined,
  attrsUnchanged: boolean,
): boolean {
  return (
    hint !== "text" && hint !== "data" && hint !== "paint" && hint !== "style" && !attrsUnchanged
  );
}

function shouldAdvanceChildSeq(hint: MutationHint | undefined): boolean {
  return typeof hint !== "object" && hint !== "data" && hint !== "paint" && hint !== "style";
}

function runPostMutationHooks(hint: MutationHint | undefined): void {
  for (const hook of postMutationHooks) {
    try {
      hook(hint);
    } catch {}
  }
}

export function markDamageNode(nodeId: number): void {
  if (!Number.isFinite(nodeId) || nodeId < 0) return;
  const cs = getInternalState();
  cs.damageNodes.add(nodeId | 0);
}
