// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Connection-scoped cache of fetched stylesheet text for the screenshot fallback.

import { MAX_STYLESHEET_BYTES } from "../read-capped.ts";

/** Retained UTF-16 code units per connection; at least one sheet at the read cap fits. */
export const MAX_STYLE_CACHE_CHARS = MAX_STYLESHEET_BYTES;

export interface StyleCacheEntry {
  css: string;
  fetchedAt: number;
}

/** Least-recently-used eviction once the retained text passes `maxChars`. */
export class StyleCache {
  readonly #entries = new Map<string, StyleCacheEntry>();
  #chars = 0;

  constructor(readonly maxChars: number = MAX_STYLE_CACHE_CHARS) {}

  get retainedChars(): number {
    return this.#chars;
  }

  get(url: string): StyleCacheEntry | undefined {
    const hit = this.#entries.get(url);
    if (hit) {
      this.#entries.delete(url);
      this.#entries.set(url, hit);
    }
    return hit;
  }

  set(url: string, entry: StyleCacheEntry): void {
    this.#remove(url);
    if (entry.css.length > this.maxChars) return;
    this.#entries.set(url, entry);
    this.#chars += entry.css.length;
    for (const oldest of this.#entries.keys()) {
      if (this.#chars <= this.maxChars) break;
      this.#remove(oldest);
    }
  }

  #remove(url: string): void {
    const old = this.#entries.get(url);
    if (!old) return;
    this.#entries.delete(url);
    this.#chars -= old.css.length;
  }
}
