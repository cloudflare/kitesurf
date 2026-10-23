// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Moves detached-tree wrappers to weak storage and reclaims wasm nodes after collection.

import { dropUnwrappedSubtrees } from "./node-base.js";
import {
  adoptedWrapperIds,
  cache,
  hostIdToDoc,
  postMutationHooks,
  weakWrappers,
} from "./registries.js";
import { DOCUMENT_ID, dom } from "./state.js";

// A live member keeps every cached wrapper in its detached tree alive as a group.
type Group = { root: number; members: Set<object> };
type Scheduler = (callback: () => void, ms: number) => unknown;

const SWEEP_DELAY_MS = 1000;
const DEMOTED_ROOTS_CLEAR_THRESHOLD = 50_000;

const groupOf = new WeakMap<object, Group>();
const demotedRoots = new Set<number>();
const registry =
  typeof FinalizationRegistry === "function" && typeof WeakRef === "function"
    ? new FinalizationRegistry<number>(reclaim)
    : null;
let schedule: Scheduler | null = null;
let sweepArmed = false;
const stats = { sweeps: 0, demoted: 0, revived: 0, groupsCollected: 0, reclaimed: 0, failures: 0 };

export function detachedWrapperStats(): { strong: number; weak: number } & typeof stats {
  return { strong: cache.size, weak: weakWrappers.size, ...stats };
}

/** Sets the scheduler used to queue the delayed detached-wrapper sweep. */
export function setWrapperSweepScheduler(scheduler: Scheduler): void {
  schedule = scheduler;
}

postMutationHooks.push((hint) => scheduleSweepForMutation(hint));

function scheduleSweepForMutation(hint: unknown): void {
  // Attribute writes, character data and Web Animations style changes cannot detach
  // a node, so none of them needs a wrapper sweep.
  if (!mutationMayDetach(hint)) return;
  const scheduler = schedule;
  if (!registry || !scheduler || sweepArmed) return;
  armSweep(scheduler);
}

function mutationMayDetach(hint: unknown): boolean {
  return typeof hint !== "object" && hint !== "data" && hint !== "style";
}

function armSweep(scheduler: Scheduler): void {
  sweepArmed = true;
  try {
    scheduler(() => {
      sweepArmed = false;
      sweepDetachedWrappers();
    }, SWEEP_DELAY_MS);
  } catch {
    sweepArmed = false;
  }
}

function rootsOf(ids: number[]): number[] {
  return Array.from(dom.detachedRoots(Uint32Array.from(ids)));
}

export function sweepDetachedWrappers(): number {
  if (!canSweepDetachedWrappers()) return 0;
  const ids = sweepCandidateIds();
  if (ids.length === 0) return 0;
  const roots = rootsForSweep(ids);
  if (!roots) return 0;
  stats.sweeps++;
  const groups = new Map<number, Group>();
  const loading = pendingImageRoots(ids, roots);
  let moved = 0;
  for (let i = 0; i < ids.length; i++) {
    moved += demoteWrapper(ids[i], roots[i], loading, groups);
  }
  stats.demoted += moved;
  return moved;
}

function canSweepDetachedWrappers(): boolean {
  return !!registry && typeof dom.detachedRoots === "function";
}

function sweepCandidateIds(): number[] {
  const ids: number[] = [];
  for (const id of cache.keys()) {
    if (id >= 0 && id !== DOCUMENT_ID && !adoptedWrapperIds.has(id)) ids.push(id);
  }
  return ids;
}

function rootsForSweep(ids: number[]): number[] | null {
  try {
    return rootsOf(ids);
  } catch {
    stats.failures++;
    return null;
  }
}

function pendingImageRoots(ids: number[], roots: number[]): Set<number> {
  // A pending image request keeps its entire detached tree out of the weak-wrapper sweep.
  const loading = new Set<number>();
  for (let i = 0; i < ids.length; i++) {
    if (roots[i] >= 0 && imageLoading(ids[i], cache.get(ids[i]))) loading.add(roots[i]);
  }
  return loading;
}

function demoteWrapper(
  id: number,
  root: number,
  loading: Set<number>,
  groups: Map<number, Group>,
): number {
  if (shouldSkipRoot(root, loading) || hostIdToDoc.has(root)) return 0;
  const wrapper = cache.get(id);
  if (!wrapper) return 0;
  const group = groupForRoot(root, groups);
  group.members.add(wrapper);
  groupOf.set(wrapper, group);
  cache.delete(id);
  weakWrappers.set(id, new WeakRef(wrapper));
  return 1;
}

function shouldSkipRoot(root: number, loading: Set<number>): boolean {
  return root < 0 || loading.has(root);
}

function groupForRoot(root: number, groups: Map<number, Group>): Group {
  let group = groups.get(root);
  if (!group) {
    group = { root, members: new Set() };
    groups.set(root, group);
    registry?.register(group, root);
    demotedRoots.add(root);
  }
  return group;
}

function imageLoading(id: number, w?: object): boolean {
  if (w && (w as { localName?: unknown }).localName !== "img") return false;
  try {
    return typeof dom.imageIsPending === "function" && dom.imageIsPending(id);
  } catch {
    return false;
  }
}

function reclaim(root: number): void {
  demotedRoots.delete(root);
  stats.groupsCollected++;
  try {
    if (rootsOf([root])[0] !== root) return;
    const ids = [root, ...Array.from(dom.descendantsOf(root))];
    if (ids.some((id) => imageLoading(id))) return;
    if (dropUnwrappedSubtrees([root]) > 0) stats.reclaimed++;
  } catch {
    stats.failures++;
  }
}

function revive(nodeId: number): void {
  demotedRoots.delete(nodeId);
  for (const id of revivedIds(nodeId)) reviveWrapper(id);
}

function revivedIds(nodeId: number): number[] {
  const ids = [nodeId];
  try {
    for (const id of dom.descendantsOf(nodeId)) ids.push(id);
  } catch {
    stats.failures++;
  }
  return ids;
}

function reviveWrapper(id: number): void {
  const ref = weakWrappers.get(id);
  if (!ref) return;
  weakWrappers.delete(id);
  const wrapper = ref.deref();
  if (wrapper === undefined) return;
  cache.set(id, wrapper);
  stats.revived++;
  const group = groupOf.get(wrapper);
  if (!group) return;
  group.members.delete(wrapper);
  groupOf.delete(wrapper);
}

function mayHoldWeak(nodeId: number): boolean {
  if (weakWrappers.size === 0) return false;
  if (weakWrappers.has(nodeId)) return true;
  if (demotedRoots.size === 0) return false;
  try {
    return demotedRoots.has(rootsOf([nodeId])[0]);
  } catch {
    return true;
  }
}

export function installDetachedWrapperHooks(handle: unknown): void {
  if (!registry) return;
  const h = handle as Record<string, unknown>;
  const proto = Object.getPrototypeOf(h) as Record<string, unknown>;
  const wrap = (name: string, nodeArg: number, after: (id: number) => void) => {
    const orig = proto[name];
    if (typeof orig !== "function") return;
    h[name] = function (this: unknown, ...args: unknown[]) {
      const id = args[nodeArg];
      const weak = typeof id === "number" && mayHoldWeak(id);
      const out = (orig as (...a: unknown[]) => unknown).apply(this, args);
      if (weak && typeof id === "number") after(id);
      return out;
    };
  };
  wrap("appendChildNode", 1, revive);
  wrap("insertBeforeNode", 1, revive);
  wrap("replaceChildNode", 0, revive);
  wrap("removeNode", 0, (id) => {
    if (demotedRoots.size > DEMOTED_ROOTS_CLEAR_THRESHOLD) demotedRoots.clear();
    demotedRoots.add(id);
  });
}
