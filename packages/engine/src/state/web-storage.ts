// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// localStorage is shared by the pages of a browser context and sessionStorage by the documents
// of a tab, but each document has its own isolate: the session keeps each origin's area here.

import type { WebStorageOp } from "@kitesurf/jsrpc-types/page-script";
import { isStoredString, type SessionStore, type StoreTable } from "./session-store.ts";

export type { WebStorageOp };

// The page's quota (web-storage.ts), checked again on the merged area: each page saw only its own
// copy, so two pages under quota can together go over, and every later page would start past it.
export const WEB_STORAGE_QUOTA_UNITS = 5 * 1024 * 1024;

const isIndexMark = (v: unknown): v is 1 => v === 1; // the index marks an origin present

// Tables: `<prefix>` indexes the origins and `<prefix>|<origin>` holds one origin's keys. The
// prefix is `localStorage`, `localStorage:<context id>` or a tab's `sessionStorage:<target id>`.
export class WebStorage {
  readonly #store: SessionStore;
  readonly #prefix: string;
  #disposed = false;

  constructor(store: SessionStore, prefix = "localStorage") {
    this.#store = store;
    this.#prefix = prefix;
  }

  forContext(contextId: string): WebStorage {
    return new WebStorage(this.#store, `localStorage:${contextId}`);
  }

  forTab(targetId: string): WebStorage {
    return new WebStorage(this.#store, `sessionStorage:${targetId}`);
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
    if (this.#disposed) return; // a page's last writes can outlive its browser context or tab
    const area = this.#store.table(this.#areaName(origin), isStoredString);
    let used = 0;
    for (const [k, v] of area.entries()) used += k.length + v.length;
    let refused = 0;
    for (const op of ops) {
      if (op.op === "set") {
        const old = area.get(op.key);
        const freed = old === undefined ? 0 : op.key.length + old.length;
        const next = used - freed + op.key.length + op.value.length;
        // Keep the old value, as the page's copy would have refused the write had it seen the
        // other pages' writes.
        if (next > WEB_STORAGE_QUOTA_UNITS) {
          refused++;
          continue;
        }
        area.set(op.key, op.value);
        used = next;
      } else if (op.op === "remove") {
        const old = area.get(op.key);
        if (old !== undefined) used -= op.key.length + old.length;
        area.delete(op.key);
      } else {
        area.clear();
        used = 0;
      }
    }
    if (refused > 0) {
      console.warn(JSON.stringify({ event: "web_storage_quota_refused", origin, refused }));
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
