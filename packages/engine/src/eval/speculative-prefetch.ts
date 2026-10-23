// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Runs speculative prefetches with a short deadline and fixed concurrency.

import { getInterception, interceptionMatches } from "../cdp/fetch-interception.ts";
import { getOutboundFilters, shouldBlock } from "../cdp/outbound-filter-registry.ts";

export const SPECULATIVE_DEADLINE_MS = 1_000;
export const SPECULATIVE_CONCURRENCY = 2;

export function maySpeculate(connectionId: string, url: string): boolean {
  const routes = getInterception(connectionId);
  if (routes && interceptionMatches(routes, url, "Script")) return false;
  const filters = getOutboundFilters(connectionId);
  return !filters || !shouldBlock(filters, url, "Script").blocked;
}

export async function prefetchBestEffort<T, R>(
  items: readonly T[],
  fetchOne: (item: T, signal: AbortSignal) => Promise<R>,
  deadlineMs = SPECULATIVE_DEADLINE_MS,
  concurrency = SPECULATIVE_CONCURRENCY,
): Promise<R[]> {
  const ctrl = new AbortController();
  const settled: R[] = [];
  const state = { next: 0 };
  const lane = () => runLane(items, fetchOne, ctrl, settled, state);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
  });
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, lane);
  await Promise.race([Promise.all(lanes), deadline]);
  clearTimeout(timer);
  ctrl.abort();
  return settled;
}

async function runLane<T, R>(
  items: readonly T[],
  fetchOne: (item: T, signal: AbortSignal) => Promise<R>,
  ctrl: AbortController,
  settled: R[],
  state: { next: number },
): Promise<void> {
  while (!ctrl.signal.aborted && state.next < items.length) {
    const item = items[state.next++];
    if (item === undefined) continue;
    await runSpeculativeItem(item, fetchOne, ctrl, settled);
  }
}

async function runSpeculativeItem<T, R>(
  item: T,
  fetchOne: (item: T, signal: AbortSignal) => Promise<R>,
  ctrl: AbortController,
  settled: R[],
): Promise<void> {
  try {
    const result = await fetchOne(item, ctrl.signal);
    if (!ctrl.signal.aborted) settled.push(result);
  } catch {}
}
