// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// boa's code store as an append-only log in a SQLite table: kept apart from boa-swap.ts,
// which installs it, so node tests can run it over node:sqlite without the wasm.

// Captured before page JS runs, since these move bytes out of views over wasm memory and a
// page that replaced them could feed boa whatever it liked.
const NativeUint8Array = Uint8Array;
const typedSet = Uint8Array.prototype.set;
const typedSubarray = Uint8Array.prototype.subarray;

// A read materialises the whole row (a 200 B read measured 22 µs at 64 KiB, 220 µs at
// 1 MiB), so rows stay small, and the last few rows read stay cached in V8's heap.
const ROW_BYTES = 64 * 1024;
const CACHE_ROWS = 4;
// Source texts below this stay resident, since their write and later delete cost more than
// they free (boa has its own floor for bytecode); past the cap everything stays resident.
export const SWAP_MIN_BYTES = 16 * 1024;
const SWAP_CAP_BYTES = 256 * 1024 * 1024;
const MAX_KEY = 0xffff_ffff; // boa keeps keys as u32

/** DO storage, the part this uses: the facet constructor's `ctx.storage`, which outlives
 * each generation's isolate while its page lives. */
export interface SwapStorage {
  sql: {
    exec(
      query: string,
      ...bindings: Array<string | number | ArrayBuffer | ArrayBufferView>
    ): {
      toArray(): Array<Record<string, unknown>>;
    };
  };
  transactionSync<T>(fn: () => T): T;
}

/** The code store as an append-only log over 64 KiB rows (row id = offset / ROW_BYTES):
 * small values (a function's bytecode is ~100 B) share rows, and a key is a log offset. */
export interface SwapLog {
  put(bytes: Uint8Array): number;
  read(key: number, offset: number, len: number): Uint8Array | undefined;
  release(key: number, len: number): void;
  flush(): void;
}

export function openSwapLog(
  s: SwapStorage,
  table: string,
  capBytes = SWAP_CAP_BYTES,
): SwapLog | null {
  let end = 0;
  try {
    s.sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY, data BLOB NOT NULL)`);
    const top = s.sql.exec(`SELECT coalesce(max(id) + 1, 0) AS rows FROM ${table}`).toArray()[0];
    end = Number(top?.rows ?? 0) * ROW_BYTES; // a reopened log starts on a fresh row
  } catch (err) {
    console.warn(`[ks-boa-swap] no store: ${String(err)}`);
    return null;
  }
  // The row being filled, in V8's heap until it is full or a round ends: a put is a copy,
  // and SQLite sees a row write per 64 KiB, not per value.
  let tail = new NativeUint8Array(ROW_BYTES);
  let tailRow = end / ROW_BYTES;
  let tailDirty = false;
  // Live bytes per row, and in all (the cap is on live bytes, since keys only grow); a
  // full row whose count drops to zero is deleted.
  const live = new Map<number, number>();
  let stored = 0;
  // Whole rows read back lately: functions that start running together sit together, so
  // most first runs after the first one in a row are a copy out of V8's heap.
  const cache = new Map<number, Uint8Array>();
  let broken = false;
  const fail = (what: string, err: unknown) => {
    if (!broken)
      console.warn(`[ks-boa-swap] ${what} failed, keeping code resident: ${String(err)}`);
    broken = true;
  };
  const writeRow = (row: number, bytes: Uint8Array) => {
    s.sql.exec(`INSERT OR REPLACE INTO ${table} (id, data) VALUES (?, ?)`, row, bytes);
  };
  const rowBytes = (row: number): Uint8Array | undefined => {
    if (row === tailRow) return tail;
    const hit = cache.get(row);
    if (hit) {
      cache.delete(row);
      cache.set(row, hit);
      return hit;
    }
    const d = s.sql.exec(`SELECT data AS d FROM ${table} WHERE id = ?`, row).toArray()[0]?.d;
    if (!(d instanceof ArrayBuffer)) return undefined;
    const bytes = new NativeUint8Array(d);
    cache.set(row, bytes);
    if (cache.size > CACHE_ROWS) cache.delete(cache.keys().next().value as number);
    return bytes;
  };
  const eachRow = (key: number, len: number, f: (row: number, from: number, n: number) => void) => {
    for (let at = key; at < key + len;) {
      const row = Math.floor(at / ROW_BYTES);
      const n = Math.min(key + len - at, (row + 1) * ROW_BYTES - at);
      f(row, at - row * ROW_BYTES, n);
      at += n;
    }
  };

  const put = (bytes: Uint8Array): number => {
    const len = bytes.length;
    if (broken || len === 0 || stored + len > capBytes || end + len > MAX_KEY) return -1;
    const key = end;
    try {
      let pos = 0;
      while (pos < len) {
        const within = end % ROW_BYTES;
        const n = Math.min(len - pos, ROW_BYTES - within);
        Reflect.apply(typedSet, tail, [
          Reflect.apply(typedSubarray, bytes, [pos, pos + n]),
          within,
        ]);
        live.set(tailRow, (live.get(tailRow) ?? 0) + n);
        stored += n;
        tailDirty = true;
        pos += n;
        end += n;
        if (end % ROW_BYTES === 0) {
          if (live.get(tailRow)) writeRow(tailRow, tail);
          else s.sql.exec(`DELETE FROM ${table} WHERE id = ?`, tailRow); // released while filling
          tail = new NativeUint8Array(ROW_BYTES);
          tailRow++;
          tailDirty = false;
        }
      }
    } catch (err) {
      fail("put", err);
      return -1;
    }
    return key;
  };

  const read = (key: number, offset: number, len: number): Uint8Array | undefined => {
    const at = key + offset;
    if (offset < 0 || len < 0 || at + len > end) return undefined;
    const out = new NativeUint8Array(len);
    let pos = 0;
    try {
      let ok = true;
      eachRow(at, len, (row, from, n) => {
        const bytes = ok ? rowBytes(row) : undefined;
        if (!bytes || from + n > bytes.length) {
          ok = false;
          return;
        }
        Reflect.apply(typedSet, out, [Reflect.apply(typedSubarray, bytes, [from, from + n]), pos]);
        pos += n;
      });
      if (!ok) return undefined;
    } catch (err) {
      fail("read", err);
      return undefined;
    }
    return out;
  };

  const release = (key: number, len: number): void => {
    try {
      eachRow(key, len, (row, _from, n) => {
        stored -= n;
        const left = (live.get(row) ?? 0) - n;
        if (left > 0 || row === tailRow) {
          live.set(row, Math.max(0, left));
          return;
        }
        live.delete(row);
        cache.delete(row);
        s.sql.exec(`DELETE FROM ${table} WHERE id = ?`, row);
      });
    } catch (err) {
      fail("release", err);
    }
  };

  const flush = (): void => {
    if (!tailDirty || broken) return;
    try {
      writeRow(tailRow, Reflect.apply(typedSubarray, tail, [0, end - tailRow * ROW_BYTES]));
      tailDirty = false;
    } catch (err) {
      fail("flush", err);
    }
  };

  return { put, read, release, flush };
}
