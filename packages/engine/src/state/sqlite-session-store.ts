// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A session store in a Durable Object's SQLite. Each table is a namespace of one SQL table,
// with one row per chunk of a value. DO SQLite is synchronous, so the store keeps the Map shape
// that the engine's hot paths use. It works only in the I/O context of the object that owns the
// storage: a loopback such as a loaded worker's SandboxOutbound must forward into the object.

import {
  rejectRow,
  type SessionStore,
  type StoreGuard,
  type StoreLimits,
  type StoreStats,
  type StoreTable,
} from "./session-store.ts";

/** The part of Durable Object storage the store uses. A Durable Object's `ctx.storage` fits. */
export interface SqliteStorage {
  readonly sql: {
    exec(
      query: string,
      ...bindings: Array<string | number | null | ArrayBuffer>
    ): { toArray(): Array<Record<string, unknown>> };
    readonly databaseSize: number;
  };
  // The statements of `fn` commit together or not at all. A value of several chunks is several
  // statements, and a failure midway (a full database) must not leave a torn value.
  transactionSync<T>(fn: () => T): T;
}

/** The limits of a store in SQLite. The data is off the heap, so the network log keeps more,
 * but each body still passes through the heap once as it is captured. */
export const SQLITE_STORE_LIMITS: Readonly<StoreLimits> = Object.freeze({
  onHeap: false,
  networkRequests: 5_000,
  networkBodyBytes: 200 * 1024 * 1024,
  networkBodyBytesPerResource: 5 * 1024 * 1024,
  imageBytes: 128 * 1024 * 1024,
  fontBytes: 64 * 1024 * 1024,
});

const TABLE = "ks_session_store";

// DO SQLite caps a string, BLOB or row at 2 MB, and a raw document is often bigger. A string
// splits by UTF-16 code units, at most 3 UTF-8 bytes each, so a chunk is at most 1.5 MB.
const STRING_CHUNK_UNITS = 512 * 1024;
const BYTES_CHUNK = 1024 * 1024;

// "s" is a string, "b" bytes, and "j" JSON.
type Tag = "s" | "b" | "j";

// SQLite keeps TEXT as UTF-8, so a lone surrogate is written as U+FFFD. Page JS can put any
// string in Web Storage, so a value with one is stored as JSON, whose escapes are ASCII. Such a
// key becomes KEY_ESCAPE plus its JSON, as does a key that starts with KEY_ESCAPE, so no plain
// key reads back as an escaped one.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const KEY_ESCAPE = "\uFFFF";

function toSqlKey(key: string): string {
  return key.startsWith(KEY_ESCAPE) || LONE_SURROGATE.test(key)
    ? KEY_ESCAPE + JSON.stringify(key)
    : key;
}

function fromSqlKey(raw: unknown): string {
  const k = String(raw);
  return k.startsWith(KEY_ESCAPE) ? String(JSON.parse(k.slice(KEY_ESCAPE.length))) : k;
}

function splitString(s: string): string[] {
  if (s.length <= STRING_CHUNK_UNITS) return [s];
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + STRING_CHUNK_UNITS, s.length);
    // Never split a surrogate pair: SQLite would store each half as U+FFFD.
    const last = s.charCodeAt(end - 1);
    if (end < s.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

function encode(value: unknown): { tag: Tag; parts: Array<string | ArrayBuffer> } {
  if (typeof value === "string" && !LONE_SURROGATE.test(value)) {
    return { tag: "s", parts: splitString(value) };
  }
  if (value instanceof Uint8Array) {
    const parts: ArrayBuffer[] = [];
    for (let i = 0; i === 0 || i < value.length; i += BYTES_CHUNK) {
      parts.push(value.slice(i, i + BYTES_CHUNK).buffer);
    }
    return { tag: "b", parts };
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("SessionStore: the value is not serializable");
  return { tag: "j", parts: splitString(json) };
}

function bytesOf(v: unknown): Uint8Array {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return new Uint8Array(0);
}

function decode(tag: unknown, parts: unknown[]): unknown {
  if (tag === "b") {
    const chunks = parts.map(bytesOf);
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
  const text = parts.map((p) => (typeof p === "string" ? p : "")).join("");
  return tag === "s" ? text : JSON.parse(text);
}

// The write gate of a store and its tables. Once the store is fenced, every write throws.
interface Fence {
  fenced: boolean;
}

function assertOpen(fence: Fence): void {
  if (fence.fenced) throw new Error("SessionStore: the session has ended and takes no writes");
}

/** A session store in SQLite. A key's insertion order is the rowid of its first chunk, which an
 * update keeps, so tables iterate in a Map's order. */
export class SqliteSessionStore implements SessionStore {
  readonly backend = "sqlite";
  readonly limits: Readonly<StoreLimits>;
  readonly #storage: SqliteStorage;
  readonly #fence: Fence = { fenced: false };

  constructor(storage: SqliteStorage, limits: Partial<Omit<StoreLimits, "onHeap">> = {}) {
    this.#storage = storage;
    this.limits = Object.freeze({ ...SQLITE_STORE_LIMITS, ...limits });
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
        ns TEXT NOT NULL,
        k TEXT NOT NULL,
        seq INTEGER NOT NULL,
        t TEXT NOT NULL,
        v,
        PRIMARY KEY (ns, k, seq)
      )`,
    );
  }

  table<V>(name: string, is: StoreGuard<V>): StoreTable<V> {
    return new SqliteTable(this.#storage, name, is, this.#fence);
  }

  /**
   * Stops all writes, for a session that has ended: work still running when it ended cannot
   * leave a row behind after its cleanup. Reads still work. A fence cannot be lifted.
   */
  fence(): void {
    this.#fence.fenced = true;
  }

  get fenced(): boolean {
    return this.#fence.fenced;
  }

  drop(name: string): void {
    assertOpen(this.#fence);
    this.#storage.sql.exec(`DELETE FROM ${TABLE} WHERE ns = ?`, name);
  }

  stats(): StoreStats {
    // length() counts the characters of TEXT and the bytes of a BLOB.
    const rows = this.#storage.sql
      .exec(
        `SELECT ns, sum(seq = 0) AS keys, sum(length(CAST(v AS BLOB))) AS bytes
         FROM ${TABLE} GROUP BY ns`,
      )
      .toArray();
    const tables: StoreStats["tables"] = {};
    let valueBytes = 0;
    let keys = 0;
    for (const r of rows) {
      const t = { keys: Number(r.keys ?? 0), bytes: Number(r.bytes ?? 0) };
      tables[String(r.ns)] = t;
      valueBytes += t.bytes;
      keys += t.keys;
    }
    const bytes = this.#storage.sql.databaseSize;
    return { backend: this.backend, bytes, valueBytes, keys, tables };
  }

  clear(): void {
    assertOpen(this.#fence);
    this.#storage.sql.exec(`DELETE FROM ${TABLE}`);
  }
}

class SqliteTable<V> implements StoreTable<V> {
  readonly #storage: SqliteStorage;
  readonly #ns: string;
  readonly #is: StoreGuard<V>;
  readonly #fence: Fence;

  constructor(storage: SqliteStorage, ns: string, is: StoreGuard<V>, fence: Fence) {
    this.#storage = storage;
    this.#ns = ns;
    this.#is = is;
    this.#fence = fence;
  }

  #exec(query: string, ...bindings: Array<string | number | null | ArrayBuffer>) {
    return this.#storage.sql.exec(query, ...bindings).toArray();
  }

  // A row that does not parse or fails the guard reads as missing, so one bad row does not fail
  // every later read of the table.
  #decode(key: string, tag: unknown, parts: unknown[]): V | undefined {
    try {
      const v = decode(tag, parts);
      if (this.#is(v)) return v;
    } catch {
      // Reported below, as a row of the wrong shape.
    }
    rejectRow(this.#ns, key);
    return undefined;
  }

  get(key: string): V | undefined {
    const rows = this.#exec(
      `SELECT t, v FROM ${TABLE} WHERE ns = ? AND k = ? ORDER BY seq`,
      this.#ns,
      toSqlKey(key),
    );
    const first = rows[0];
    if (!first) return undefined;
    return this.#decode(
      key,
      first.t,
      rows.map((r) => r.v),
    );
  }

  has(key: string): boolean {
    const sqlKey = toSqlKey(key);
    const q = `SELECT 1 AS x FROM ${TABLE} WHERE ns = ? AND k = ? AND seq = 0`;
    return this.#exec(q, this.#ns, sqlKey).length > 0;
  }

  set(key: string, value: V): this {
    assertOpen(this.#fence);
    const { tag, parts } = encode(value);
    const sqlKey = toSqlKey(key);
    this.#storage.transactionSync(() => {
      this.#exec(`DELETE FROM ${TABLE} WHERE ns = ? AND k = ? AND seq > 0`, this.#ns, sqlKey);
      this.#exec(
        `INSERT INTO ${TABLE} (ns, k, seq, t, v) VALUES (?, ?, 0, ?, ?)
         ON CONFLICT (ns, k, seq) DO UPDATE SET t = excluded.t, v = excluded.v`,
        this.#ns,
        sqlKey,
        tag,
        parts[0] ?? "",
      );
      for (let i = 1; i < parts.length; i++) {
        this.#exec(
          `INSERT INTO ${TABLE} (ns, k, seq, t, v) VALUES (?, ?, ?, ?, ?)`,
          this.#ns,
          sqlKey,
          i,
          tag,
          parts[i] ?? "",
        );
      }
    });
    return this;
  }

  delete(key: string): boolean {
    assertOpen(this.#fence);
    if (!this.has(key)) return false;
    this.#exec(`DELETE FROM ${TABLE} WHERE ns = ? AND k = ?`, this.#ns, toSqlKey(key));
    return true;
  }

  clear(): void {
    assertOpen(this.#fence);
    this.#exec(`DELETE FROM ${TABLE} WHERE ns = ?`, this.#ns);
  }

  get size(): number {
    const q = `SELECT count(*) AS n FROM ${TABLE} WHERE ns = ? AND seq = 0`;
    return Number(this.#exec(q, this.#ns)[0]?.n ?? 0);
  }

  // Snapshots, not live cursors: callers delete while they iterate, which a Map allows.
  keys(): IterableIterator<string> {
    const q = `SELECT k FROM ${TABLE} WHERE ns = ? AND seq = 0 ORDER BY rowid`;
    return this.#exec(q, this.#ns)
      .map((r) => fromSqlKey(r.k))
      [Symbol.iterator]();
  }

  values(): IterableIterator<V> {
    return this.#entryList()
      .map(([, v]) => v)
      [Symbol.iterator]();
  }

  entries(): IterableIterator<[string, V]> {
    return this.#entryList()[Symbol.iterator]();
  }

  #entryList(): Array<[string, V]> {
    const rows = this.#exec(
      `SELECT c.k AS k, c.t AS t, c.v AS v
       FROM ${TABLE} h JOIN ${TABLE} c ON c.ns = h.ns AND c.k = h.k
       WHERE h.ns = ? AND h.seq = 0
       ORDER BY h.rowid, c.seq`,
      this.#ns,
    );
    // The rows arrive grouped by key, with the chunks in order.
    const out: Array<[string, V]> = [];
    let key: string | null = null;
    let tag: unknown = null;
    let parts: unknown[] = [];
    const flush = () => {
      if (key === null) return;
      const v = this.#decode(key, tag, parts);
      if (v !== undefined) out.push([key, v]);
    };
    for (const row of rows) {
      const k = fromSqlKey(row.k);
      if (k !== key) {
        flush();
        key = k;
        tag = row.t;
        parts = [];
      }
      parts.push(row.v);
    }
    flush();
    return out;
  }
}
