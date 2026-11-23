// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// What a session keeps off the isolate heap: its store, when the store is off the heap, and the
// databases of its page facets. Moving those bytes off the heap is the point, so they stay
// visible: Kitesurf.getMemoryStats and the "Storage" Memory-panel target report them beside the
// heap totals, not in them.

import type { StoreStats } from "../state/session-store.ts";
import type { PageStorageStats } from "../eval/page-script-host.ts";
import type { BrowserState } from "./types.ts";

export interface StorageMemory {
  // The database files: the session's and each running page's.
  bytes: number;
  // The values that the session store keeps.
  valueBytes: number;
  session: StoreStats;
  pages: Record<string, PageStorageStats>;
}

/** Null for a session whose store is on the heap: the heap rows already count it. */
export async function storageMemory(browser: BrowserState): Promise<StorageMemory | null> {
  if (browser.store.limits.onHeap) return null;
  const session = browser.store.stats();
  const pages = (await browser.pageScriptHost?.storageStats()) ?? {};
  let bytes = session.bytes;
  for (const page of Object.values(pages)) bytes += page.bytes;
  return { bytes, valueBytes: session.valueBytes, session, pages };
}
