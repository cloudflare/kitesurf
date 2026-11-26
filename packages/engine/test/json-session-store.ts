// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A store that keeps every value serialised, as a database backend does: a read hands back a
// copy, and a value that does not round-trip through JSON comes back changed. Tests use it to
// check that the engine keeps its data in the session store and writes back what it changes.

import {
  MEMORY_STORE_LIMITS,
  type SessionStore,
  type StoreGuard,
  type StoreLimits,
  type StoreStats,
  type StoreTable,
} from "../src/state/session-store.ts";

type Row =
  | { kind: "string"; value: string }
  | { kind: "bytes"; value: Uint8Array }
  | {
      kind: "json";
      value: string;
    };

function encode(value: unknown): Row {
  if (typeof value === "string") return { kind: "string", value };
  if (value instanceof Uint8Array) return { kind: "bytes", value: value.slice() };
  return { kind: "json", value: JSON.stringify(value) };
}

function decode(row: Row): unknown {
  if (row.kind === "bytes") return row.value.slice();
  if (row.kind === "json") return JSON.parse(row.value);
  return row.value;
}

export class JsonSessionStore implements SessionStore {
  readonly backend = "json-test";
  readonly limits: Readonly<StoreLimits>;
  readonly #tables = new Map<string, Map<string, Row>>();

  constructor(limits: Partial<StoreLimits> = {}) {
    this.limits = { ...MEMORY_STORE_LIMITS, onHeap: false, ...limits };
  }

  /** The tables that hold at least one row. */
  tableNames(): string[] {
    return Array.from(this.#tables)
      .filter(([, rows]) => rows.size > 0)
      .map(([name]) => name);
  }

  /** The rows of `name` as stored, decoded. */
  rows(name: string): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const [k, row] of this.#tables.get(name) ?? []) out.set(k, decode(row));
    return out;
  }

  table<V>(name: string, is: StoreGuard<V>): StoreTable<V> {
    let rows = this.#tables.get(name);
    if (!rows) {
      rows = new Map();
      this.#tables.set(name, rows);
    }
    return new JsonTable(rows, is);
  }

  drop(name: string): void {
    this.#tables.delete(name);
  }

  clear(): void {
    this.#tables.clear();
  }

  stats(): StoreStats {
    const tables: StoreStats["tables"] = {};
    let keys = 0;
    let bytes = 0;
    for (const [name, rows] of this.#tables) {
      let size = 0;
      for (const row of rows.values()) size += row.value.length;
      tables[name] = { keys: rows.size, bytes: size };
      keys += rows.size;
      bytes += size;
    }
    return { backend: this.backend, bytes, valueBytes: bytes, keys, tables };
  }
}

class JsonTable<V> implements StoreTable<V> {
  readonly #rows: Map<string, Row>;
  readonly #is: StoreGuard<V>;

  constructor(rows: Map<string, Row>, is: StoreGuard<V>) {
    this.#rows = rows;
    this.#is = is;
  }

  #read(row: Row | undefined): V | undefined {
    if (row === undefined) return undefined;
    const v = decode(row);
    return this.#is(v) ? v : undefined;
  }

  get(key: string): V | undefined {
    return this.#read(this.#rows.get(key));
  }

  has(key: string): boolean {
    return this.#rows.has(key);
  }

  set(key: string, value: V): this {
    this.#rows.set(key, encode(value));
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
    for (const [k, row] of Array.from(this.#rows)) {
      const v = this.#read(row);
      if (v !== undefined) yield [k, v];
    }
  }
}
