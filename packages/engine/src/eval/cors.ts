// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Implements page-fetch CORS checks, preflight requests, and response-header filtering.

export type CredentialsMode = "omit" | "same-origin" | "include";

const SAFELISTED_RESPONSE_HEADERS = new Set([
  "cache-control",
  "content-language",
  "content-length",
  "content-type",
  "expires",
  "last-modified",
  "pragma",
]);

const FORBIDDEN_RESPONSE_HEADERS = new Set(["set-cookie", "set-cookie2"]);

const PLUMBING_PREFIX = "x-kitesurf-";

const UA_OWNED_REQUEST_HEADERS = new Set([
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

const SAFELISTED_METHODS = new Set(["GET", "HEAD", "POST"]);

const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_CORS_SAFE_HEADER_VALUE_CHARS = 128;
const MAX_PREFLIGHT_CACHE_AGE_SECONDS = 600;
const MILLISECONDS_PER_SECOND = 1_000;

export function isHttpToken(s: string): boolean {
  return s.length > 0 && TOKEN_RE.test(s);
}

function stripHttpWhitespace(s: string): string {
  return s.replace(/^[\t\n\r ]+/, "").replace(/[\t\n\r ]+$/, "");
}

export function parseTokenList(value: string | null): string[] | null {
  if (value === null) return null;
  const out: string[] = [];
  for (const raw of value.split(",")) {
    const item = stripHttpWhitespace(raw);
    if (item === "") continue;
    if (!isHttpToken(item)) return null;
    out.push(item);
  }
  return out;
}

function hasCorsUnsafeByte(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 && c !== 0x09) return true;
    if (c === 0x7f) return true;
    if (
      c === 0x22 ||
      c === 0x28 ||
      c === 0x29 ||
      c === 0x3a ||
      c === 0x3c ||
      c === 0x3e ||
      c === 0x3f ||
      c === 0x40 ||
      c === 0x5b ||
      c === 0x5c ||
      c === 0x5d ||
      c === 0x7b ||
      c === 0x7d
    ) {
      return true;
    }
  }
  return false;
}

function mimeEssence(input: string): string | null {
  const s = stripHttpWhitespace(input);
  const slash = s.indexOf("/");
  if (slash < 0) return null;
  const type = s.slice(0, slash);
  if (!isHttpToken(type)) return null;
  const rest = s.slice(slash + 1);
  const semi = rest.indexOf(";");
  const subtype = (semi < 0 ? rest : rest.slice(0, semi)).replace(/[\t\n\r ]+$/, "");
  if (!isHttpToken(subtype)) return null;
  return `${type}/${subtype}`.toLowerCase();
}

function safelistedRangeStart(value: string): number | null {
  if (!value.startsWith("bytes=")) return null;
  let i = 6;
  const collectDigits = (): string => {
    let out = "";
    for (;;) {
      const ch = value[i];
      if (ch === undefined || ch < "0" || ch > "9") return out;
      out += ch;
      i++;
    }
  };
  const startDigits = collectDigits();
  if (value[i] !== "-") return null;
  i++;
  const endDigits = collectDigits();
  if (i !== value.length) return null;
  if (startDigits === "") return null;
  const start = Number(startDigits);
  if (endDigits !== "" && start > Number(endDigits)) return null;
  return start;
}

export function isSafelistedRequestHeader(name: string, value: string): boolean {
  if (value.length > MAX_CORS_SAFE_HEADER_VALUE_CHARS) return false;
  switch (name.toLowerCase()) {
    case "accept":
      return !hasCorsUnsafeByte(value);
    case "accept-language":
    case "content-language":
      return /^[0-9A-Za-z *,\-.;=]*$/.test(value);
    case "content-type": {
      if (hasCorsUnsafeByte(value)) return false;
      const essence = mimeEssence(value);
      return (
        essence === "application/x-www-form-urlencoded" ||
        essence === "multipart/form-data" ||
        essence === "text/plain"
      );
    }
    case "range":
      return safelistedRangeStart(value) !== null;
    default:
      return false;
  }
}

// page-script marks the headers a fetch cache mode added, not the page; only these two qualify.
const CACHE_MODE_MARK = "x-kitesurf-cache-mode";
const CACHE_MODE_REQUEST_HEADERS = new Set(["cache-control", "pragma"]);

function cacheModeHeaders(headers: Headers): Set<string> {
  const marked = new Set<string>();
  for (const raw of (headers.get(CACHE_MODE_MARK) ?? "").split(",")) {
    const name = raw.trim().toLowerCase();
    if (CACHE_MODE_REQUEST_HEADERS.has(name)) marked.add(name);
  }
  return marked;
}

export function corsUnsafeRequestHeaderNames(headers: Headers): string[] {
  const unsafe = new Set<string>();
  const fromCacheMode = cacheModeHeaders(headers);
  for (const [rawName, value] of headers.entries()) {
    const name = rawName.toLowerCase();
    if (name.startsWith("x-kitesurf-")) continue;
    if (UA_OWNED_REQUEST_HEADERS.has(name)) continue;
    if (fromCacheMode.has(name)) continue;
    if (name.startsWith("proxy-") || name.startsWith("sec-")) continue;
    if (!isSafelistedRequestHeader(name, value)) unsafe.add(name);
  }
  return [...unsafe].sort();
}

export function needsPreflight(method: string, headers: Headers): boolean {
  if (!SAFELISTED_METHODS.has(method.toUpperCase())) return true;
  return corsUnsafeRequestHeaderNames(headers).length > 0;
}

export function isSafelistedMethod(method: string): boolean {
  return SAFELISTED_METHODS.has(method.toUpperCase());
}

export function filterCorsResponseHeaders(headers: Headers, credentialsInclude: boolean): Headers {
  const exposed = parseTokenList(headers.get("access-control-expose-headers"));
  const wildcard = !credentialsInclude && exposed !== null && exposed.includes("*");
  const explicit = new Set((exposed ?? []).map((n) => n.toLowerCase()));
  const out = new Headers();
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_RESPONSE_HEADERS.has(lower)) continue;
    if (lower.startsWith(PLUMBING_PREFIX)) continue;
    if (SAFELISTED_RESPONSE_HEADERS.has(lower)) {
      out.append(name, value);
      continue;
    }
    if (wildcard || explicit.has(lower)) out.append(name, value);
  }
  return out;
}

export interface CorsPreflightVerdict {
  reason: string | null;
  message?: string;
}

export function corsCheck(
  headers: Headers,
  requestOrigin: string,
  credentialsInclude: boolean,
): string | null {
  const aca = headers.get("access-control-allow-origin");
  if (aca === null) return "cors-missing-origin";
  const trimmed = stripHttpWhitespace(aca);
  if (trimmed === "*") {
    if (credentialsInclude) return "cors-wildcard-with-credentials";
    return null;
  }
  if (trimmed !== requestOrigin) {
    if (trimmed.includes(",")) return "cors-multiple-origins";
    return "cors-origin-mismatch";
  }
  if (credentialsInclude) {
    const acc = headers.get("access-control-allow-credentials");
    if (acc !== "true") return "cors-credentials-not-allowed";
  }
  return null;
}

interface PreflightEntry {
  methods: string[];
  methodWildcard: boolean;
  headerNames: Set<string>;
  headerWildcard: boolean;
  expiresAt: number;
}

const preflightCache = new Map<string, PreflightEntry>();

const PREFLIGHT_CACHE_MAX = 512;

function cacheKey(
  partition: string,
  origin: string,
  url: string,
  credentialsInclude: boolean,
): string {
  return JSON.stringify([partition, origin, url, credentialsInclude]);
}

function entrySatisfies(
  entry: PreflightEntry,
  method: string,
  unsafeNames: string[],
  credentialsInclude: boolean,
): boolean {
  if (entry.expiresAt <= Date.now()) return false;
  const methodOk =
    entry.methods.includes(method) ||
    isSafelistedMethod(method) ||
    (entry.methodWildcard && !credentialsInclude);
  if (!methodOk) return false;
  for (const name of unsafeNames) {
    if (entry.headerNames.has(name)) continue;
    if (entry.headerWildcard && !credentialsInclude && name !== "authorization") {
      continue;
    }
    return false;
  }
  return true;
}

export function preflightCacheLookup(
  partition: string,
  origin: string,
  url: string,
  method: string,
  unsafeNames: string[],
  credentialsInclude: boolean,
): boolean {
  const entry = preflightCache.get(cacheKey(partition, origin, url, credentialsInclude));
  if (!entry) return false;
  return entrySatisfies(entry, method, unsafeNames, credentialsInclude);
}

function storePreflight(
  partition: string,
  origin: string,
  url: string,
  credentialsInclude: boolean,
  entry: PreflightEntry,
): void {
  if (entry.expiresAt <= Date.now()) return;
  if (preflightCache.size >= PREFLIGHT_CACHE_MAX) {
    const oldest = preflightCache.keys().next();
    if (!oldest.done) preflightCache.delete(oldest.value);
  }
  preflightCache.set(cacheKey(partition, origin, url, credentialsInclude), entry);
}

export function clearPreflightCache(): void {
  preflightCache.clear();
}

export interface CorsPreflightRequest {
  // Browser context the grant belongs to: the sealed cookie key. Grants never
  // cross it, and an empty partition is never cached.
  partition: string;
  url: string;
  method: string;
  unsafeNames: string[];
  requestOrigin: string;
  credentialsInclude: boolean;
  userAgent: string;
  // Mirrors the real request's Referer so both hops agree.
  referer: string | null;
  // Cancels the OPTIONS round-trip. Callers must pass one: every egress needs a
  // deadline.
  signal: AbortSignal;
  // False when a host egress hook answers: it may answer for any server, and the
  // cache is shared by every session in the isolate.
  cacheable?: boolean;
}

// Fetch §cors-preflight-fetch. `doFetch` is injected so outbound
// keeps ownership of the egress path (proxy, breaker, tracing).
export async function corsPreflight(
  req: CorsPreflightRequest,
  doFetch: (r: Request) => Promise<Response>,
): Promise<CorsPreflightVerdict> {
  const { url, method, unsafeNames, requestOrigin, credentialsInclude } = req;
  const headers = new Headers();
  headers.set("accept", "*/*");
  headers.set("user-agent", req.userAgent);
  if (req.referer) headers.set("referer", req.referer);
  headers.set("origin", requestOrigin);
  headers.set("access-control-request-method", method);
  if (unsafeNames.length > 0) {
    headers.set("access-control-request-headers", unsafeNames.join(","));
  }
  let resp: Response;
  try {
    resp = await doFetch(
      new Request(url, {
        method: "OPTIONS",
        headers,
        redirect: "manual",
        signal: req.signal,
      }),
    );
  } catch {
    return { reason: "cors-preflight-failed" };
  }
  // Cancel the ignored body so the OPTIONS socket closes.
  try {
    await resp.body?.cancel();
  } catch {}
  if (resp.status < 200 || resp.status > 299) {
    return {
      reason: "cors-preflight-status",
      message: `preflight response status ${resp.status} is not ok`,
    };
  }
  const originFailure = corsCheck(resp.headers, requestOrigin, credentialsInclude);
  if (originFailure) return { reason: originFailure };

  const rawMethods = resp.headers.get("access-control-allow-methods");
  const rawAllowHeaders = resp.headers.get("access-control-allow-headers");
  const methods = rawMethods === null ? [] : parseTokenList(rawMethods);
  const allowHeaders = rawAllowHeaders === null ? [] : parseTokenList(rawAllowHeaders);
  if (methods === null || allowHeaders === null) {
    return { reason: "cors-preflight-invalid-header" };
  }
  const methodWildcard = methods.includes("*");
  const headerWildcard = allowHeaders.includes("*");
  const methodOk =
    methods.includes(method) ||
    isSafelistedMethod(method) ||
    (methodWildcard && !credentialsInclude);
  if (!methodOk) {
    return {
      reason: "cors-method-not-allowed",
      message: `method ${method} is not allowed by Access-Control-Allow-Methods`,
    };
  }
  const allowed = new Set(allowHeaders.map((n) => n.toLowerCase()));
  for (const name of unsafeNames) {
    if (allowed.has(name)) continue;
    if (headerWildcard && !credentialsInclude && name !== "authorization") {
      continue;
    }
    return {
      reason: "cors-header-not-allowed",
      message: `request header ${name} is not allowed by Access-Control-Allow-Headers`,
    };
  }

  const rawMaxAge = resp.headers.get("access-control-max-age");
  const maxAge = rawMaxAge !== null && /^[0-9]+$/.test(rawMaxAge) ? Number(rawMaxAge) : 0;
  const seconds = maxAge > 0 ? Math.min(maxAge, MAX_PREFLIGHT_CACHE_AGE_SECONDS) : 0;
  if (seconds > 0 && req.cacheable !== false && req.partition !== "") {
    storePreflight(req.partition, requestOrigin, url, credentialsInclude, {
      methods,
      methodWildcard,
      headerNames: allowed,
      headerWildcard,
      expiresAt: Date.now() + seconds * MILLISECONDS_PER_SECOND,
    });
  }
  return { reason: null };
}
