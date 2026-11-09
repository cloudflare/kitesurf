// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// localStorage is shared by every page of a browser context, but each document has its own
// isolate: the session keeps each origin's area here, and a page works on a copy (web-storage.ts).

import type { WebStorageOp } from "@kitesurf/jsrpc-types/page-script";
import { isStoredString, type SessionStore, type StoreTable } from "./session-store.ts";

export type { WebStorageOp };

const isIndexMark = (v: unknown): v is 1 => v === 1; // the index marks an origin present

// Tables: `<prefix>` indexes the origins and `<prefix>|<origin>` holds one origin's keys, where
// the prefix is `localStorage` for the default context and `localStorage:<id>` for another.
export class WebStorage {
  readonly #store: SessionStore;
  readonly #prefix: string;
  #disposed = false;

  constructor(store: SessionStore, contextId?: string) {
    this.#store = store;
    this.#prefix = contextId ? `localStorage:${contextId}` : "localStorage";
  }

  forContext(contextId: string): WebStorage {
    return new WebStorage(this.#store, contextId);
  }

  #index(): StoreTable<1> {
    return this.#store.table(this.#prefix, isIndexMark);
  }

  #areaName(origin: string): string {
    return `${this.#prefix}|${origin}`;
  }

  origins(): string[] {
    return Array.from(this.#index().keys());
  }

  entries(origin: string): Array<[string, string]> {
    if (!this.#index().has(origin)) return [];
    return Array.from(this.#store.table(this.#areaName(origin), isStoredString).entries());
  }

  apply(origin: string, ops: readonly WebStorageOp[]): void {
    if (this.#disposed) return; // a page's last writes can outlive its browser context
    const area = this.#store.table(this.#areaName(origin), isStoredString);
    for (const op of ops) {
      if (op.op === "set") area.set(op.key, op.value);
      else if (op.op === "remove") area.delete(op.key);
      else area.clear();
    }
    if (area.size > 0) this.#index().set(origin, 1);
    else this.#drop(origin);
  }

  clear(): void {
    for (const origin of this.origins()) this.#drop(origin);
    this.#store.drop(this.#prefix);
  }

  dispose(): void {
    this.clear();
    this.#disposed = true;
  }

  #drop(origin: string): void {
    this.#store.drop(this.#areaName(origin));
    this.#index().delete(origin);
  }
}

/** The origin whose area a document at `url` uses, or null for an opaque origin (data:,
 * about:blank), which matches no other document and so keeps its storage in the page. */
export function webStorageOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}
