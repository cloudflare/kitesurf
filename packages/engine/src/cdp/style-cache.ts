// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Connection-scoped cache of fetched stylesheet text for the screenshot fallback.

import { MAX_STYLESHEET_BYTES } from "../read-capped.ts";
import type { StoreTable } from "../state/session-store.ts";

/** Retained UTF-16 code units per connection; at least one sheet at the read cap fits. */
export const MAX_STYLE_CACHE_CHARS = MAX_STYLESHEET_BYTES;

export interface StyleCacheEntry {
  css: string;
  fetchedAt: number;
}

export function isStyleCacheEntry(v: unknown): v is StyleCacheEntry {
  if (typeof v !== "object" || v === null) return false;
  const e: Record<string, unknown> = { ...v };
  return typeof e.css === "string" && typeof e.fetchedAt === "number";
}

/** Least-recently-used eviction once the retained text passes `maxChars`. The text lives in
 * `entries`, a session-store table; the recency order and sizes stay in memory, so a hit
 * rewrites nothing. */
export class StyleCache {
  readonly #entries: StoreTable<StyleCacheEntry>;
  // Each cached URL and its length in code units, least recently used first.
  readonly #order = new Map<string, number>();
  #chars = 0;

  constructor(
    readonly maxChars: number = MAX_STYLE_CACHE_CHARS,
    entries: StoreTable<StyleCacheEntry> = new Map<string, StyleCacheEntry>(),
  ) {
    this.#entries = entries;
  }

  get retainedChars(): number {
    return this.#chars;
  }

  get(url: string): StyleCacheEntry | undefined {
    const chars = this.#order.get(url);
    if (chars === undefined) return undefined;
    const hit = this.#entries.get(url);
    if (!hit) {
      this.#remove(url);
      return undefined;
    }
    this.#order.delete(url);
    this.#order.set(url, chars);
    return hit;
  }

  set(url: string, entry: StyleCacheEntry): void {
    this.#remove(url);
    if (entry.css.length > this.maxChars) return;
    this.#entries.set(url, entry);
    this.#order.set(url, entry.css.length);
    this.#chars += entry.css.length;
    for (const oldest of Array.from(this.#order.keys())) {
      if (this.#chars <= this.maxChars) break;
      this.#remove(oldest);
    }
  }

  #remove(url: string): void {
    const chars = this.#order.get(url);
    if (chars === undefined) return;
    this.#order.delete(url);
    this.#entries.delete(url);
    this.#chars -= chars;
  }
}
