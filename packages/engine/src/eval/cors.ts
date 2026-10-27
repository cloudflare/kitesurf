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
const CORS_UNSAFE_PUNCTUATION_BYTES = new Set([
  0x22, 0x28, 0x29, 0x3a, 0x3c, 0x3e, 0x3f, 0x40, 0x5b, 0x5c, 0x5d, 0x7b, 0x7d,
]);
const SAFELISTED_CONTENT_TYPES = new Set([
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
]);

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
    if (isCorsUnsafeByte(c)) return true;
  }
  return false;
}

function isCorsUnsafeByte(byte: number): boolean {
  return (byte < 0x20 && byte !== 0x09) || byte === 0x7f || CORS_UNSAFE_PUNCTUATION_BYTES.has(byte);
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

interface RangeDigits {
  value: string;
  index: number;
}

function collectRangeDigits(value: string, start: number): RangeDigits {
  let index = start;
  let digits = "";
  for (;;) {
    const ch = value[index];
    if (ch === undefined || ch < "0" || ch > "9") return { value: digits, index };
    digits += ch;
    index++;
  }
}

interface RangeStart {
  value: number;
  index: number;
}

function parseRangeStart(value: string): RangeStart | null {
  if (!value.startsWith("bytes=")) return null;
  const start = collectRangeDigits(value, 6);
  if (start.value === "") return null;
  if (value[start.index] !== "-") return null;
  return { value: Number(start.value), index: start.index + 1 };
}

function rangeEndFits(start: number, endDigits: string): boolean {
  return endDigits === "" || start <= Number(endDigits);
}

function safelistedRangeStart(value: string): number | null {
  const start = parseRangeStart(value);
  if (start === null) return null;
  const end = collectRangeDigits(value, start.index);
  if (end.index !== value.length) return null;
  if (!rangeEndFits(start.value, end.value)) return null;
  return start.value;
}

function isSafelistedContentType(value: string): boolean {
  if (hasCorsUnsafeByte(value)) return false;
  return SAFELISTED_CONTENT_TYPES.has(mimeEssence(value) ?? "");
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
      return isSafelistedContentType(value);
    }
    case "range":
      return safelistedRangeStart(value) !== null;
    default:
      return false;
  }
}

export function corsUnsafeRequestHeaderNames(headers: Headers): string[] {
  const unsafe = new Set<string>();
  for (const [rawName, value] of headers.entries()) {
    const name = rawName.toLowerCase();
    if (isIgnoredCorsRequestHeader(name)) continue;
    if (!isSafelistedRequestHeader(name, value)) unsafe.add(name);
  }
  return [...unsafe].sort();
}

function isIgnoredCorsRequestHeader(name: string): boolean {
  return (
    name.startsWith("x-kitesurf-") ||
    UA_OWNED_REQUEST_HEADERS.has(name) ||
    name.startsWith("proxy-") ||
    name.startsWith("sec-")
  );
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
  const originFailure = corsOriginFailure(trimmed, requestOrigin, credentialsInclude);
  if (originFailure !== null) return originFailure;
  if (credentialsInclude && headers.get("access-control-allow-credentials") !== "true") {
    return "cors-credentials-not-allowed";
  }
  return null;
}

function corsOriginFailure(
  origin: string,
  requestOrigin: string,
  credentialsInclude: boolean,
): string | null {
  if (origin === "*") {
    if (credentialsInclude) return "cors-wildcard-with-credentials";
    return null;
  }
  if (origin !== requestOrigin) {
    if (origin.includes(",")) return "cors-multiple-origins";
    return "cors-origin-mismatch";
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

function cacheKey(origin: string, url: string, credentialsInclude: boolean): string {
  return `${origin}\u0000${url}\u0000${credentialsInclude ? "1" : "0"}`;
}

function entrySatisfies(
  entry: PreflightEntry,
  method: string,
  unsafeNames: string[],
  credentialsInclude: boolean,
): boolean {
  if (entry.expiresAt <= Date.now()) return false;
  if (!preflightMethodAllowed(entry.methods, method, entry.methodWildcard, credentialsInclude)) {
    return false;
  }
  for (const name of unsafeNames) {
    if (
      !preflightHeaderAllowed(entry.headerNames, entry.headerWildcard, credentialsInclude, name)
    ) {
      return false;
    }
  }
  return true;
}

function preflightMethodAllowed(
  methods: string[],
  method: string,
  wildcard: boolean,
  credentialsInclude: boolean,
): boolean {
  return (
    methods.includes(method) || isSafelistedMethod(method) || (wildcard && !credentialsInclude)
  );
}

function preflightHeaderAllowed(
  allowed: Set<string>,
  wildcard: boolean,
  credentialsInclude: boolean,
  name: string,
): boolean {
  return allowed.has(name) || (wildcard && !credentialsInclude && name !== "authorization");
}

export function preflightCacheLookup(
  origin: string,
  url: string,
  method: string,
  unsafeNames: string[],
  credentialsInclude: boolean,
): boolean {
  const entry = preflightCache.get(cacheKey(origin, url, credentialsInclude));
  if (!entry) return false;
  return entrySatisfies(entry, method, unsafeNames, credentialsInclude);
}

function storePreflight(
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
  preflightCache.set(cacheKey(origin, url, credentialsInclude), entry);
}

export function clearPreflightCache(): void {
  preflightCache.clear();
}

export interface CorsPreflightRequest {
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
function preflightRequestHeaders(
  req: CorsPreflightRequest,
  requestOrigin: string,
  method: string,
  unsafeNames: string[],
): Headers {
  const headers = new Headers();
  headers.set("accept", "*/*");
  headers.set("user-agent", req.userAgent);
  if (req.referer) headers.set("referer", req.referer);
  headers.set("origin", requestOrigin);
  headers.set("access-control-request-method", method);
  if (unsafeNames.length > 0) {
    headers.set("access-control-request-headers", unsafeNames.join(","));
  }
  return headers;
}

type PreflightFetchResult =
  | { ok: true; response: Response }
  | { ok: false; verdict: CorsPreflightVerdict };

async function fetchPreflightResponse(
  url: string,
  signal: AbortSignal,
  headers: Headers,
  doFetch: (request: Request) => Promise<Response>,
): Promise<PreflightFetchResult> {
  let response: Response;
  try {
    response = await doFetch(
      new Request(url, {
        method: "OPTIONS",
        headers,
        redirect: "manual",
        signal,
      }),
    );
  } catch {
    return { ok: false, verdict: { reason: "cors-preflight-failed" } };
  }
  // Cancel the ignored body so the OPTIONS socket closes.
  try {
    await response.body?.cancel();
  } catch {}
  return { ok: true, response };
}

function preflightStatusFailure(response: Response): CorsPreflightVerdict | null {
  if (response.status < 200 || response.status > 299) {
    return {
      reason: "cors-preflight-status",
      message: `preflight response status ${response.status} is not ok`,
    };
  }
  return null;
}

function preflightTokenHeader(value: string | null): string[] | null {
  return value === null ? [] : parseTokenList(value);
}

interface PreflightTokenHeaders {
  methods: string[];
  allowHeaders: string[];
}

function preflightTokenHeaders(headers: Headers): PreflightTokenHeaders | null {
  const methods = preflightTokenHeader(headers.get("access-control-allow-methods"));
  const allowHeaders = preflightTokenHeader(headers.get("access-control-allow-headers"));
  if (methods === null || allowHeaders === null) {
    return null;
  }
  return { methods, allowHeaders };
}

function corsPreflightHeaderFailure(
  unsafeNames: string[],
  allowed: Set<string>,
  headerWildcard: boolean,
  credentialsInclude: boolean,
): CorsPreflightVerdict | null {
  for (const name of unsafeNames) {
    if (preflightHeaderAllowed(allowed, headerWildcard, credentialsInclude, name)) continue;
    return {
      reason: "cors-header-not-allowed",
      message: `request header ${name} is not allowed by Access-Control-Allow-Headers`,
    };
  }
  return null;
}

type PreflightPolicyResult =
  | { ok: false; verdict: CorsPreflightVerdict }
  | {
      ok: true;
      methods: string[];
      methodWildcard: boolean;
      allowed: Set<string>;
      headerWildcard: boolean;
    };

function preflightPolicy(
  response: Response,
  method: string,
  unsafeNames: string[],
  requestOrigin: string,
  credentialsInclude: boolean,
): PreflightPolicyResult {
  const originFailure = corsCheck(response.headers, requestOrigin, credentialsInclude);
  if (originFailure !== null) return { ok: false, verdict: { reason: originFailure } };
  const tokenHeaders = preflightTokenHeaders(response.headers);
  if (tokenHeaders === null) {
    return { ok: false, verdict: { reason: "cors-preflight-invalid-header" } };
  }
  const methodWildcard = tokenHeaders.methods.includes("*");
  const headerWildcard = tokenHeaders.allowHeaders.includes("*");
  if (!preflightMethodAllowed(tokenHeaders.methods, method, methodWildcard, credentialsInclude)) {
    return {
      ok: false,
      verdict: {
        reason: "cors-method-not-allowed",
        message: `method ${method} is not allowed by Access-Control-Allow-Methods`,
      },
    };
  }
  const allowed = new Set(tokenHeaders.allowHeaders.map((name) => name.toLowerCase()));
  const headerFailure = corsPreflightHeaderFailure(
    unsafeNames,
    allowed,
    headerWildcard,
    credentialsInclude,
  );
  if (headerFailure !== null) return { ok: false, verdict: headerFailure };
  return {
    ok: true,
    methods: tokenHeaders.methods,
    methodWildcard,
    allowed,
    headerWildcard,
  };
}

function preflightMaxAgeSeconds(rawMaxAge: string | null): number {
  if (rawMaxAge === null || !/^[0-9]+$/.test(rawMaxAge)) return 0;
  const maxAge = Number(rawMaxAge);
  return maxAge > 0 ? Math.min(maxAge, MAX_PREFLIGHT_CACHE_AGE_SECONDS) : 0;
}

function cachePreflightResponse(
  req: CorsPreflightRequest,
  response: Response,
  methods: string[],
  methodWildcard: boolean,
  allowed: Set<string>,
  headerWildcard: boolean,
): void {
  const seconds = preflightMaxAgeSeconds(response.headers.get("access-control-max-age"));
  if (seconds > 0 && req.cacheable !== false) {
    storePreflight(req.requestOrigin, req.url, req.credentialsInclude, {
      methods,
      methodWildcard,
      headerNames: allowed,
      headerWildcard,
      expiresAt: Date.now() + seconds * MILLISECONDS_PER_SECOND,
    });
  }
}

export async function corsPreflight(
  req: CorsPreflightRequest,
  doFetch: (r: Request) => Promise<Response>,
): Promise<CorsPreflightVerdict> {
  const { url, method, unsafeNames, requestOrigin, credentialsInclude } = req;
  const headers = preflightRequestHeaders(req, requestOrigin, method, unsafeNames);
  const fetched = await fetchPreflightResponse(url, req.signal, headers, doFetch);
  if (!fetched.ok) return fetched.verdict;
  const statusFailure = preflightStatusFailure(fetched.response);
  if (statusFailure !== null) return statusFailure;
  const policy = preflightPolicy(
    fetched.response,
    method,
    unsafeNames,
    requestOrigin,
    credentialsInclude,
  );
  if (!policy.ok) return policy.verdict;
  cachePreflightResponse(
    req,
    fetched.response,
    policy.methods,
    policy.methodWildcard,
    policy.allowed,
    policy.headerWildcard,
  );
  return { reason: null };
}
