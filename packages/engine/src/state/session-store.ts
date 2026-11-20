// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Where a browser session keeps its data: the network log and response bodies, cookie jars,
// new-document scripts and compiled sources all live in named tables of one store. Unless a
// host supplies one, every table is a plain Map and nothing leaves the isolate heap.

// Synchronous and Map-shaped on purpose: the engine's hot paths (a cookie lookup per fetch, a
// record per request) keep their shape, and a Map already satisfies StoreTable.

// Live handles (RPC stubs, DOM handles, timers, promises) never go in a store: they mean
// nothing outside the isolate holding them.

/** Checks a value read back from a table. A read that fails it is logged and treated as
 * missing, so a row of the wrong shape never reaches the caller as a V. */
export type StoreGuard<V> = (value: unknown) => value is V;

export const isStoredString: StoreGuard<string> = (v): v is string => typeof v === "string";
export const isStoredBytes: StoreGuard<Uint8Array> = (v): v is Uint8Array =>
  v instanceof Uint8Array;

function rejectRow(table: string, key: string): void {
  console.warn(JSON.stringify({ event: "session_store_row_rejected", table, key }));
}

// Write back after mutating: the memory backend hands out the stored object itself, while a
// serialising backend hands out a copy, so `get`-mutate-`set` is what works with both.
/** A Map-shaped table. `Map<string, V>` satisfies it. */
export interface StoreTable<V> {
  get(key: string): V | undefined;
  has(key: string): boolean;
  set(key: string, value: V): this;
  delete(key: string): boolean;
  clear(): void;
  readonly size: number;
  // Insertion order, like a Map: re-setting a key keeps its position.
  keys(): IterableIterator<string>;
  values(): IterableIterator<V>;
  entries(): IterableIterator<[string, V]>;
}

/** What a store holds, for the engine's memory surfaces. */
export interface StoreStats {
  backend: string;
  // The database file, pages and indexes included; for the memory
  // backend the same as valueBytes.
  bytes: number;
  // Stored values: UTF-8 bytes of strings and JSON, length of binaries.
  valueBytes: number;
  keys: number;
  tables: Record<string, { keys: number; bytes: number }>;
}

// A backend may be bound to the execution context that created it, so only touch a store from
// where the host made it.
export interface SessionStore {
  // Lets callers size what they keep: the heap-bound limits that protect
  // a shared isolate don't apply to data a host keeps outside it.
  readonly backend: string;
  /**
   * Sizes per table. Walks every value on the memory backend and runs an
   * aggregate on a database backend, so it is for diagnostics, not hot paths.
   */
  stats(): StoreStats;
  /**
   * The table called `name`, created empty on first use. Values are strings, Uint8Arrays or
   * anything JSON round-trips; `is` checks every value read back.
   */
  table<V>(name: string, is: StoreGuard<V>): StoreTable<V>;
  /** Delete a table and everything in it. */
  drop(name: string): void;
  /** Delete every table. */
  clear(): void;
}

export class MemorySessionStore implements SessionStore {
  readonly backend = "memory";
  readonly #tables = new Map<string, Map<string, unknown>>();

  table<V>(name: string, is: StoreGuard<V>): StoreTable<V> {
    let t = this.#tables.get(name);
    if (!t) {
      t = new Map();
      this.#tables.set(name, t);
    }
    return new MemoryTable(name, t, is);
  }

  drop(name: string): void {
    this.#tables.get(name)?.clear();
    this.#tables.delete(name);
  }

  stats(): StoreStats {
    const tables: StoreStats["tables"] = {};
    let valueBytes = 0;
    let keys = 0;
    for (const [name, t] of this.#tables) {
      let bytes = 0;
      for (const v of t.values()) bytes += encodedBytes(v);
      tables[name] = { keys: t.size, bytes };
      valueBytes += bytes;
      keys += t.size;
    }
    return { backend: "memory", bytes: valueBytes, valueBytes, keys, tables };
  }

  clear(): void {
    for (const t of this.#tables.values()) t.clear();
    this.#tables.clear();
  }
}

// A typed view of one memory table. The rows are whatever this session
// set, so a failed check means two callers disagree on a table's type.
class MemoryTable<V> implements StoreTable<V> {
  readonly #name: string;
  readonly #rows: Map<string, unknown>;
  readonly #is: StoreGuard<V>;

  constructor(name: string, rows: Map<string, unknown>, is: StoreGuard<V>) {
    this.#name = name;
    this.#rows = rows;
    this.#is = is;
  }

  #check(key: string, v: unknown): V | undefined {
    if (v === undefined) return undefined;
    if (this.#is(v)) return v;
    rejectRow(this.#name, key);
    return undefined;
  }

  get(key: string): V | undefined {
    return this.#check(key, this.#rows.get(key));
  }

  has(key: string): boolean {
    return this.#rows.has(key);
  }

  set(key: string, value: V): this {
    this.#rows.set(key, value);
    return this;
  }

  delete(key: string): boolean {
    return this.#rows.delete(key);
  }

  clear(): void {
    this.#rows.clear();
  }

  get size(): number {
    return this.#rows.size;
  }

  keys(): IterableIterator<string> {
    return this.#rows.keys();
  }

  *values(): IterableIterator<V> {
    for (const [, v] of this.entries()) yield v;
  }

  *entries(): IterableIterator<[string, V]> {
    for (const [k, raw] of this.#rows) {
      const v = this.#check(k, raw);
      if (v !== undefined) yield [k, v];
    }
  }
}

const utf8 = new TextEncoder();
function encodedBytes(value: unknown): number {
  if (typeof value === "string") return utf8.encode(value).length;
  if (value instanceof Uint8Array) return value.byteLength;
  const json = JSON.stringify(value);
  return json === undefined ? 0 : utf8.encode(json).length;
}
