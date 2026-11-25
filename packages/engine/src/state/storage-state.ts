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

// Bounds on what one file can make the command do. Chrome keeps at most 3300 cookies, and the
// jar holds 3000 (cookies.ts), so a file a browser wrote fits.
export const MAX_STORAGE_STATE_COOKIES = 10_000;
export const MAX_STORAGE_STATE_ORIGINS = 1_000;

// playwright's largest `expires`, 9999-12-31T23:59:59Z in Unix seconds.
const MAX_EXPIRES_SECONDS = 253402300799;

// What rebuilding a Set-Cookie header from the fields must not let through: a ";" starts an
// attribute, a "=" in a name moves the name-value split, and controls (Chrome allows a tab) end or
// corrupt the header.
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f]/;

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
  const rawCookies = optionalArray(root.cookies, "storageState.cookies");
  if (rawCookies.length > MAX_STORAGE_STATE_COOKIES) {
    throw new StorageStateError(`storageState.cookies: over ${MAX_STORAGE_STATE_COOKIES} cookies`);
  }
  const cookies = rawCookies
    .map((raw, i) => parseCookie(raw, `storageState.cookies[${i}]`))
    // An `expires` of 0 is the epoch: Chrome takes the cookie as expired and stores nothing.
    .filter((c) => c.expires !== 0);
  const rawOrigins = optionalArray(root.origins, "storageState.origins");
  const origins = new Map<string, Map<string, string>>();
  const units = new Map<string, number>();
  rawOrigins.forEach((raw, i) => parseOrigin(raw, `storageState.origins[${i}]`, origins, units));
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
    // An origin with no area and no keys needs nothing; applying a clear would make its area.
    if (keys.size === 0 && !out.has(origin)) continue;
    const ops: LocalStorageOp[] = [{ op: "clear" }];
    for (const [key, value] of keys) ops.push({ op: "set", key, value });
    out.set(origin, ops);
  }
  return out;
}

function parseCookie(raw: unknown, where: string): StorageStateCookie {
  const c = asObject(raw, where);
  const out: StorageStateCookie = {
    name: cookieField(c.name, `${where}.name`, /[;=]/),
    value: cookieField(c.value, `${where}.value`, /;/),
  };
  const url = optionalString(c.url, `${where}.url`);
  const domain = optionalCookieField(c.domain, `${where}.domain`);
  const path = optionalCookieField(c.path, `${where}.path`);
  // playwright's rule: a url, or a domain and a path, never both.
  let secure: boolean | undefined;
  if (url !== undefined) {
    if (domain !== undefined || path !== undefined) {
      throw new StorageStateError(`${where}: give either url or domain and path, not both`);
    }
    if (localStorageOrigin(url) === null) {
      throw new StorageStateError(`${where}.url: not an http(s) URL: ${url}`);
    }
    // As playwright's rewriteCookies: the URL gives the path up to its last "/", and the scheme
    // gives `secure`, whatever the file says.
    const u = new URL(url);
    out.url = url;
    out.path = cookieField(
      u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1),
      `${where}.url`,
      /;/,
    );
    secure = u.protocol === "https:";
  } else {
    if (domain === undefined || path === undefined) {
      throw new StorageStateError(`${where}: needs a url, or a domain and a path`);
    }
    // Chrome refuses such a path; the jar would keep it and never send the cookie.
    if (!path.startsWith("/")) {
      throw new StorageStateError(`${where}.path: does not start with "/"`);
    }
    out.domain = domain;
    out.path = path;
  }
  if (c.expires !== undefined) {
    const expires = c.expires;
    if (typeof expires !== "number" || !Number.isFinite(expires)) {
      throw new StorageStateError(`${where}.expires: not a number`);
    }
    // playwright's rule: -1 for a session cookie, else Unix seconds up to the year 9999.
    if ((expires < 0 && expires !== -1) || expires > MAX_EXPIRES_SECONDS) {
      throw new StorageStateError(`${where}.expires: must be -1 or Unix seconds`);
    }
    out.expires = expires;
  }
  if (c.httpOnly !== undefined) out.httpOnly = asBoolean(c.httpOnly, `${where}.httpOnly`);
  const givenSecure = c.secure === undefined ? undefined : asBoolean(c.secure, `${where}.secure`);
  secure ??= givenSecure;
  if (secure !== undefined) out.secure = secure;
  if (c.sameSite !== undefined) {
    if (c.sameSite !== "Strict" && c.sameSite !== "Lax" && c.sameSite !== "None") {
      throw new StorageStateError(`${where}.sameSite: must be "Strict", "Lax" or "None"`);
    }
    out.sameSite = c.sameSite;
  }
  return out;
}

// Merge one `origins` entry into `origins`. `unitsByOrigin` keeps each origin's total, so a
// file that repeats an origin costs no more than one that does not.
function parseOrigin(
  raw: unknown,
  where: string,
  origins: Map<string, Map<string, string>>,
  unitsByOrigin: Map<string, number>,
): void {
  const o = asObject(raw, where);
  const given = asString(o.origin, `${where}.origin`);
  const origin = localStorageOrigin(given);
  if (origin === null) {
    throw new StorageStateError(`${where}.origin: not an http(s) origin: ${given}`);
  }
  let keys = origins.get(origin);
  if (!keys) {
    if (origins.size >= MAX_STORAGE_STATE_ORIGINS) {
      throw new StorageStateError(`${where}: over ${MAX_STORAGE_STATE_ORIGINS} origins`);
    }
    origins.set(origin, (keys = new Map()));
  }
  let units = unitsByOrigin.get(origin) ?? 0;
  optionalArray(o.localStorage, `${where}.localStorage`).forEach((raw, i) => {
    const e = asObject(raw, `${where}.localStorage[${i}]`);
    const name = asString(e.name, `${where}.localStorage[${i}].name`);
    const value = asString(e.value, `${where}.localStorage[${i}].value`);
    const old = keys.get(name);
    units += name.length + value.length - (old === undefined ? 0 : name.length + old.length);
    keys.set(name, value);
  });
  // The quota a page's own writes meet (state/local-storage.ts).
  if (units > LOCAL_STORAGE_QUOTA_UNITS) {
    throw new StorageStateError(
      `${where}.localStorage: over the ${LOCAL_STORAGE_QUOTA_UNITS}-unit quota`,
    );
  }
  unitsByOrigin.set(origin, units);
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

// A string that setCdpCookie can put in a Set-Cookie header as it is.
function cookieField(v: unknown, where: string, forbidden = /;/): string {
  const s = asString(v, where);
  const bad = CONTROL.exec(s) ?? forbidden.exec(s);
  if (bad) {
    throw new StorageStateError(`${where}: has ${JSON.stringify(bad[0])}, which a cookie cannot`);
  }
  return s;
}

function optionalCookieField(v: unknown, where: string): string | undefined {
  return v === undefined ? undefined : cookieField(v, where);
}

function optionalString(v: unknown, where: string): string | undefined {
  return v === undefined ? undefined : asString(v, where);
}

function asBoolean(v: unknown, where: string): boolean {
  if (typeof v !== "boolean") throw new StorageStateError(`${where}: not a boolean`);
  return v;
}
