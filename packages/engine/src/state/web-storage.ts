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

// What a connection's areas may hold together. A page can walk as many origins as it likes, and
// every area it fills stays on the engine's heap until the connection closes.
export const WEB_STORAGE_TOTAL_UNITS = 2 * WEB_STORAGE_QUOTA_UNITS;

const isUnits = (v: unknown): v is number => typeof v === "number" && v >= 0;

export type WebStorageScope = "local" | "session";

// Tables: `<prefix>` holds each origin's used units and `<prefix>|<origin>` its keys. The prefix
// is `localStorage`, `localStorage:<context id>` or a tab's `sessionStorage:<target id>`.
export class WebStorage<Scope extends WebStorageScope = "local"> {
  // Type-only. Both scopes are one class, so without it a tab's areas would typecheck in a
  // browser context's place, and session data would be kept as localStorage.
  declare readonly scope: Scope;
  readonly #store: SessionStore;
  readonly #prefix: string;
  readonly #total: { units: number }; // shared by every area cut from one store
  #disposed = false;

  constructor(store: SessionStore, prefix = "localStorage", total = { units: 0 }) {
    this.#store = store;
    this.#prefix = prefix;
    this.#total = total;
  }

  forContext(contextId: string): WebStorage {
    return new WebStorage(this.#store, `localStorage:${contextId}`, this.#total);
  }

  forTab(targetId: string): WebStorage<"session"> {
    return new WebStorage<"session">(this.#store, `sessionStorage:${targetId}`, this.#total);
  }

  #index(): StoreTable<number> {
    return this.#store.table(this.#prefix, isUnits);
  }

  #areaName(origin: string): string {
    return `${this.#prefix}|${origin}`;
  }

  /** UTF-16 units held by every area that shares this one's store. */
  totalUnits(): number {
    return this.#total.units;
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
    const before = this.#index().get(origin) ?? 0;
    const others = this.#total.units - before;
    let used = before;
    let refused = 0;
    for (const op of ops) {
      if (op.op === "set") {
        const old = area.get(op.key);
        const freed = old === undefined ? 0 : op.key.length + old.length;
        const next = used - freed + op.key.length + op.value.length;
        // Keep the old value, as the page's copy would have refused the write had it seen the
        // other pages' writes; past the connection's total, a growing write is refused too.
        const overTotal = next > used && others + next > WEB_STORAGE_TOTAL_UNITS;
        if (next > WEB_STORAGE_QUOTA_UNITS || overTotal) {
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
    this.#total.units = others + used;
    if (area.size > 0) {
      this.#index().set(origin, used);
    } else {
      this.#store.drop(this.#areaName(origin));
      this.#index().delete(origin);
    }
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
    this.#total.units -= this.#index().get(origin) ?? 0;
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
