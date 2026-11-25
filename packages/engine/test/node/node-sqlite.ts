// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Durable Object storage over node:sqlite, so node tests run the SQL a Durable Object runs. DO
// SQLite reads a BLOB back as an ArrayBuffer, and so does this.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { SqliteStorage } from "../../src/state/sqlite-session-store.ts";

export interface NodeSqlite extends SqliteStorage {
  /** Runs SQL outside the store, to damage a row. */
  raw(query: string): void;
}

export function nodeSqlite(): NodeSqlite {
  const db = new DatabaseSync(":memory:");
  return {
    sql: {
      exec(query, ...bindings) {
        const stmt = db.prepare(query);
        const args: SQLInputValue[] = bindings.map((b) =>
          b instanceof ArrayBuffer ? new Uint8Array(b) : b,
        );
        const rows = stmt.columns().length > 0 ? stmt.all(...args) : (stmt.run(...args), []);
        return {
          toArray: () =>
            rows.map((row) => {
              const out: Record<string, unknown> = {};
              for (const [k, v] of Object.entries(row)) {
                out[k] = v instanceof Uint8Array ? v.slice().buffer : v;
              }
              return out;
            }),
        };
      },
      get databaseSize() {
        const row = db
          .prepare(
            "SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()",
          )
          .get();
        return Number(row?.n ?? 0);
      },
    },
    transactionSync(fn) {
      db.exec("BEGIN");
      try {
        const out = fn();
        db.exec("COMMIT");
        return out;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    raw(query) {
      db.exec(query);
    },
  };
}
