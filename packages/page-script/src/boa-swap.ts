// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A page isolate's own storage as boa's code store, so cold code leaves wasm memory. Each
// generation writes one table, named after it, and the host drops a dead generation's.

import { openSwapLog, SWAP_MIN_BYTES, type SwapStorage } from "./swap-log.ts";
import { ks_set_code_store, ks_set_swap_budget } from "./wasm-glue.js";

// Live wasm bytes past which an allocation first forces a swap round. A flat value: what else
// the isolate holds is not modelled here, so this is deliberately far below the hard limit.
export const SWAP_BUDGET_BYTES = 96 * 1024 * 1024;

let storage: SwapStorage | null = null;

/** Keep boa's swapped code in this isolate's storage. Called before the generation's
 * openSession installs the store. */
export function useBoaSwapStorage(s: SwapStorage): void {
  storage = s;
}

const SWAP_TABLE = /^ks_boa_swap_\d+$/;

export function swapTableName(generation: number): string {
  return `ks_boa_swap_${generation}`;
}

/** The swap tables in this facet's database and the bytes their rows hold, dead
 * generations' included: their tables stay until the page closes. */
export function swapTableStats(s: SwapStorage): { tables: number; bytes: number } {
  let tables = 0;
  let bytes = 0;
  for (const row of s.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()) {
    const name = String(row.name);
    if (!SWAP_TABLE.test(name)) continue;
    tables++;
    const sum = s.sql
      .exec(`SELECT coalesce(sum(length(data)), 0) AS n FROM "${name}"`)
      .toArray()[0];
    bytes += Number(sum?.n ?? 0);
  }
  return { tables, bytes };
}

// One store per isolate: boa's swapped bytecode names no store of its own, so a second
// session on this generation must keep appending to the same log.
let installed = false;

/** Install the store for this generation, before page JS can compile anything in boa. A
 * page with no facet storage (stateless, OOPIF, worker) installs nothing. */
export function installBoaSwap(generation: number): void {
  const s = storage;
  if (installed || !s || !Number.isSafeInteger(generation) || generation < 0) return;
  const log = openSwapLog(s, swapTableName(generation));
  if (!log) return;
  installed = true;
  ks_set_code_store(SWAP_MIN_BYTES, log.put, log.read, log.release, log.flush);
  ks_set_swap_budget(SWAP_BUDGET_BYTES);
}
