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

postMutationHooks.push((hint) => {
  // Attribute writes, character data and Web Animations style changes cannot detach
  // a node, so none of them needs a wrapper sweep.
  if (typeof hint === "object" || hint === "data" || hint === "style") return;
  if (!registry || !schedule || sweepArmed) return;
  sweepArmed = true;
  try {
    schedule(() => {
      sweepArmed = false;
      sweepDetachedWrappers();
    }, SWEEP_DELAY_MS);
  } catch {
    sweepArmed = false;
  }
});

function rootsOf(ids: number[]): number[] {
  return Array.from(dom.detachedRoots(Uint32Array.from(ids)));
}

export function sweepDetachedWrappers(): number {
  if (!registry || typeof dom.detachedRoots !== "function") return 0;
  const ids: number[] = [];
  for (const id of cache.keys()) {
    if (id >= 0 && id !== DOCUMENT_ID && !adoptedWrapperIds.has(id)) ids.push(id);
  }
  if (ids.length === 0) return 0;
  let roots: number[];
  try {
    roots = rootsOf(ids);
  } catch {
    stats.failures++;
    return 0;
  }
  stats.sweeps++;
  const groups = new Map<number, Group>();
  // A pending image request keeps its entire detached tree out of the weak-wrapper sweep.
  const loading = new Set<number>();
  for (let i = 0; i < ids.length; i++) {
    if (roots[i] >= 0 && imageLoading(ids[i], cache.get(ids[i]))) loading.add(roots[i]);
  }
  let moved = 0;
  for (let i = 0; i < ids.length; i++) {
    const root = roots[i];
    if (root < 0 || loading.has(root)) continue;
    // DetachedDocument owns this host even though it has no parent in the main tree.
    if (hostIdToDoc.has(root)) continue;
    const id = ids[i];
    const w = cache.get(id);
    if (!w) continue;
    let g = groups.get(root);
    if (!g) {
      g = { root, members: new Set() };
      groups.set(root, g);
      registry.register(g, root);
      demotedRoots.add(root);
    }
    g.members.add(w);
    groupOf.set(w, g);
    cache.delete(id);
    weakWrappers.set(id, new WeakRef(w));
    moved++;
  }
  stats.demoted += moved;
  return moved;
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
  const strongIds = [nodeId];
  try {
    for (const id of dom.descendantsOf(nodeId)) strongIds.push(id);
  } catch {
    stats.failures++;
  }
  for (const id of strongIds) {
    const ref = weakWrappers.get(id);
    if (!ref) continue;
    weakWrappers.delete(id);
    const w = ref.deref();
    if (w === undefined) continue;
    cache.set(id, w);
    stats.revived++;
    const g = groupOf.get(w);
    if (g) {
      g.members.delete(w);
      groupOf.delete(w);
    }
  }
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
