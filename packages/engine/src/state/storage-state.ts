// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// playwright's storageState file, the one `context.storageState({ path })` writes, which
// Kitesurf.setStorageState loads into a browser context (cdp/kitesurf.ts). Kitesurf keeps its
// cookies and localStorage and ignores the rest (`indexedDB`, `opfs`, a cookie's `partitionKey`),
// so a file a real browser wrote still loads. The wire shape is in cdp/protocol-extensions.ts.

import type { Protocol } from "devtools-protocol";
import {
  LOCAL_STORAGE_QUOTA_UNITS,
  localStorageOrigin,
  type LocalStorageOp,
} from "./local-storage.ts";

export type StorageStateCookie = Protocol.Kitesurf.StorageStateCookie;

/** A checked storageState: each origin's keys in file order, a repeated key's last value. */
export interface ParsedStorageState {
  cookies: StorageStateCookie[];
  origins: Map<string, Map<string, string>>;
}

/** Why a storageState did not parse. The message names the field. */
export class StorageStateError extends Error {}

/** Check a storageState off the wire. Throws StorageStateError. */
export function parseStorageState(value: unknown): ParsedStorageState {
  const root = asObject(value, "storageState");
  const cookies = optionalArray(root.cookies, "storageState.cookies").map((raw, i) =>
    parseCookie(raw, `storageState.cookies[${i}]`),
  );
  const origins = new Map<string, Map<string, string>>();
  optionalArray(root.origins, "storageState.origins").forEach((raw, i) =>
    parseOrigin(raw, `storageState.origins[${i}]`, origins),
  );
  return { cookies, origins };
}

/**
 * The ops that make a localStorage holding `current` origins hold the file's: every origin the
 * file leaves out is cleared, and every origin it lists is cleared and then set.
 */
export function storageStateOps(
  state: ParsedStorageState,
  current: Iterable<string>,
): Map<string, LocalStorageOp[]> {
  const out = new Map<string, LocalStorageOp[]>();
  for (const origin of current) out.set(origin, [{ op: "clear" }]);
  for (const [origin, keys] of state.origins) {
    const ops: LocalStorageOp[] = [{ op: "clear" }];
    for (const [key, value] of keys) ops.push({ op: "set", key, value });
    out.set(origin, ops);
  }
  return out;
}

function parseCookie(raw: unknown, where: string): StorageStateCookie {
  const c = asObject(raw, where);
  const out: StorageStateCookie = {
    name: asString(c.name, `${where}.name`),
    value: asString(c.value, `${where}.value`),
  };
  const url = optionalString(c.url, `${where}.url`);
  const domain = optionalString(c.domain, `${where}.domain`);
  const path = optionalString(c.path, `${where}.path`);
  // playwright's rule: a url, or a domain and a path, never both.
  if (url !== undefined) {
    if (domain !== undefined || path !== undefined) {
      throw new StorageStateError(`${where}: give either url or domain and path, not both`);
    }
    if (localStorageOrigin(url) === null) {
      throw new StorageStateError(`${where}.url: not an http(s) URL: ${url}`);
    }
    out.url = url;
  } else {
    if (domain === undefined || path === undefined) {
      throw new StorageStateError(`${where}: needs a url, or a domain and a path`);
    }
    out.domain = domain;
    out.path = path;
  }
  if (c.expires !== undefined) {
    if (typeof c.expires !== "number" || !Number.isFinite(c.expires)) {
      throw new StorageStateError(`${where}.expires: not a number`);
    }
    out.expires = c.expires;
  }
  if (c.httpOnly !== undefined) out.httpOnly = asBoolean(c.httpOnly, `${where}.httpOnly`);
  if (c.secure !== undefined) out.secure = asBoolean(c.secure, `${where}.secure`);
  if (c.sameSite !== undefined) {
    if (c.sameSite !== "Strict" && c.sameSite !== "Lax" && c.sameSite !== "None") {
      throw new StorageStateError(`${where}.sameSite: must be "Strict", "Lax" or "None"`);
    }
    out.sameSite = c.sameSite;
  }
  return out;
}

function parseOrigin(raw: unknown, where: string, origins: Map<string, Map<string, string>>): void {
  const o = asObject(raw, where);
  const given = asString(o.origin, `${where}.origin`);
  const origin = localStorageOrigin(given);
  if (origin === null) {
    throw new StorageStateError(`${where}.origin: not an http(s) origin: ${given}`);
  }
  let keys = origins.get(origin);
  if (!keys) origins.set(origin, (keys = new Map()));
  optionalArray(o.localStorage, `${where}.localStorage`).forEach((raw, i) => {
    const e = asObject(raw, `${where}.localStorage[${i}]`);
    const name = asString(e.name, `${where}.localStorage[${i}].name`);
    keys.set(name, asString(e.value, `${where}.localStorage[${i}].value`));
  });
  // The quota a page's own writes meet (state/local-storage.ts).
  let units = 0;
  for (const [name, value] of keys) units += name.length + value.length;
  if (units > LOCAL_STORAGE_QUOTA_UNITS) {
    throw new StorageStateError(
      `${where}.localStorage: over the ${LOCAL_STORAGE_QUOTA_UNITS}-unit quota`,
    );
  }
}

function asObject(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new StorageStateError(`${where}: not an object`);
  }
  return v as Record<string, unknown>;
}

function optionalArray(v: unknown, where: string): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new StorageStateError(`${where}: not an array`);
  return v;
}

function asString(v: unknown, where: string): string {
  if (typeof v !== "string") throw new StorageStateError(`${where}: not a string`);
  return v;
}

function optionalString(v: unknown, where: string): string | undefined {
  return v === undefined ? undefined : asString(v, where);
}

function asBoolean(v: unknown, where: string): boolean {
  if (typeof v !== "boolean") throw new StorageStateError(`${where}: not a boolean`);
  return v;
}
