// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A browser context's localStorage. It is per origin and shared by every page of the context,
// but each document runs in its own isolate, so the engine keeps each origin's area here. A
// navigation hands the page a copy, the page sends each change back (page-script web-storage.ts),
// and the engine sends it on to the other open copies (cdp/storage-copies.ts).

// Tables: `localStorage` indexes the default context's origins, and `localStorage|<origin>`
// holds one origin's keys. A browser context's tables carry its id: `localStorage:<id>` and
// `localStorage:<id>|<origin>`.

import type { LocalStorageOp } from "@kitesurf/jsrpc-types/page-script";
import { isStoredString, type SessionStore, type StoreGuard } from "./session-store.ts";

export type { LocalStorageOp };

// The per-origin quota the page enforces on its copy: 5 MiB of UTF-16 code units, keys and values
// together. The page's check is the one script sees, so the engine applies whatever the page
// accepted: an area passes the quota only when pages of one origin write at once, and the next
// copy seeded from it refuses to grow.
export const LOCAL_STORAGE_QUOTA_UNITS = 5 * 1024 * 1024;

// A memory bound, not a quota: only many pages of one origin filling their copies at once reach
// it. A set past it is dropped with a warning, since the page that made it already returned.
export const LOCAL_STORAGE_AREA_LIMIT_UNITS = 2 * LOCAL_STORAGE_QUOTA_UNITS;

// The rendering stand-in URL page.ts sanitizeBaseUrl gives about:blank and setDocumentContent's
// blank page. Those documents have opaque origins, so they must not share an area under it.
const SYNTHETIC_ORIGIN = "https://kitesurf.local";

/** A change to an area, with the value it replaced, as DOMStorage events report it. */
export type LocalStorageChange =
  | { op: "set"; key: string; value: string; oldValue: string | null }
  | { op: "remove"; key: string; oldValue: string }
  | { op: "clear" };

export interface LocalStorageApplied {
  applied: LocalStorageOp[];
  changes: LocalStorageChange[];
}

const isIndexed: StoreGuard<true> = (v): v is true => v === true;

export class LocalStorage {
  readonly #store: SessionStore;
  readonly #prefix: string;
  // Code units per origin, counted on first use so a store that outlives this object stays right.
  readonly #units = new Map<string, number>();
  #disposed = false;

  constructor(store: SessionStore, contextId?: string) {
    this.#store = store;
    this.#prefix = contextId ? `localStorage:${contextId}` : "localStorage";
  }

  /** The localStorage of browser context `contextId`, in the same store. */
  forContext(contextId: string): LocalStorage {
    return new LocalStorage(this.#store, contextId);
  }

  #index() {
    return this.#store.table(this.#prefix, isIndexed);
  }

  #area(origin: string) {
    return this.#store.table(`${this.#prefix}|${origin}`, isStoredString);
  }

  /** Origins that have an area, in the order they got one. */
  origins(): string[] {
    // Reading a table creates it, so a disposed context must not read at all.
    if (this.#disposed) return [];
    return Array.from(this.#index().keys());
  }

  entries(origin: string): Array<[string, string]> {
    if (this.#disposed || !this.#index().has(origin)) return [];
    return Array.from(this.#area(origin).entries());
  }

  /**
   * Apply changes; a set past `limit` units is dropped. Returns the ops applied and what changed:
   * a set to the same value or a remove of a missing key changes nothing.
   */
  apply(
    origin: string,
    ops: readonly LocalStorageOp[],
    limit = LOCAL_STORAGE_AREA_LIMIT_UNITS,
  ): LocalStorageApplied {
    const out: LocalStorageApplied = { applied: [], changes: [] };
    // A page's last writes can land after its browser context is gone.
    if (this.#disposed || ops.length === 0) return out;
    const area = this.#area(origin);
    let units = this.#units.get(origin) ?? this.#count(origin);
    for (const op of ops) {
      if (op.op === "clear") {
        if (area.size > 0) out.changes.push({ op: "clear" });
        area.clear();
        units = 0;
        out.applied.push(op);
        continue;
      }
      const old = area.get(op.key);
      const freed = old === undefined ? 0 : op.key.length + old.length;
      if (op.op === "set") {
        const next = units - freed + op.key.length + op.value.length;
        if (next > limit) {
          // A caller with a stricter limit reports the refusal itself.
          if (limit === LOCAL_STORAGE_AREA_LIMIT_UNITS) {
            console.warn(`[kitesurf-local-storage] ${origin}: dropped a set past the area limit`);
          }
          continue;
        }
        area.set(op.key, op.value);
        units = next;
        if (old !== op.value) out.changes.push({ ...op, oldValue: old ?? null });
      } else {
        units -= freed;
        area.delete(op.key);
        if (old !== undefined) out.changes.push({ ...op, oldValue: old });
      }
      out.applied.push(op);
    }
    if (area.size > 0) {
      this.#index().set(origin, true);
      this.#units.set(origin, units);
    } else {
      this.#drop(origin);
    }
    return out;
  }

  /** Drop every origin's area. */
  clear(): void {
    for (const origin of this.origins()) this.#drop(origin);
    this.#store.drop(this.#prefix);
  }

  /** Drop everything and ignore later writes: the context is gone. */
  dispose(): void {
    this.clear();
    this.#disposed = true;
  }

  #count(origin: string): number {
    let units = 0;
    for (const [k, v] of this.#area(origin).entries()) units += k.length + v.length;
    return units;
  }

  #drop(origin: string): void {
    this.#store.drop(`${this.#prefix}|${origin}`);
    this.#index().delete(origin);
    this.#units.delete(origin);
  }
}

/**
 * The origin whose area a document at `url` uses, or null when the engine keeps none: an opaque
 * origin (data:, about:blank or its stand-in URL) matches no other, so its storage stays in page.
 */
export function localStorageOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.origin === SYNTHETIC_ORIGIN) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The well-formed ops of a `kitesurf.localStorage` event. Upstream params are page data. */
export function readLocalStorageOps(params: { readonly ops?: unknown }): LocalStorageOp[] {
  const out: LocalStorageOp[] = [];
  if (!Array.isArray(params.ops)) return out;
  for (const raw of params.ops as unknown[]) {
    if (typeof raw !== "object" || raw === null) continue;
    const op = raw as { op?: unknown; key?: unknown; value?: unknown };
    if (op.op === "clear") out.push({ op: "clear" });
    else if (op.op === "remove" && typeof op.key === "string") {
      out.push({ op: "remove", key: op.key });
    } else if (op.op === "set" && typeof op.key === "string" && typeof op.value === "string") {
      out.push({ op: "set", key: op.key, value: op.value });
    }
  }
  return out;
}
