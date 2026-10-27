// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Stores page cookies and selects entries for requests and document.cookie reads.

import { isIpHost, isPublicSuffix, siteKey } from "./public-suffix.ts";

const MAX_COOKIE_BYTES = 4096;
const MAX_COOKIES_PER_HOST = 180;
const MAX_COOKIES_TOTAL = 3000;
const MILLISECONDS_PER_SECOND = 1_000;
const FORBIDDEN_COOKIE_NAME_BYTES = new Set([
  0x28, 0x29, 0x2c, 0x2f, 0x5b, 0x5c, 0x5d, 0x7b, 0x7d, 0x22,
]);
const FORBIDDEN_COOKIE_VALUE_BYTES = new Set([0x22, 0x2c, 0x3b, 0x5c]);

export interface CookieEntry {
  name: string;
  value: string;
  host: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "Strict" | "Lax" | "None" | null;
  hostOnly: boolean;
  expiresAt: number | null;
  createdAt: number;
}

export interface RequestContext {
  initiatorHost: string | null;
  topLevel?: boolean;
}

export interface CookieJar {
  /** Returns cookies matching the URL and optional SameSite request context. */
  getForUrl(urlStr: string, ctx?: RequestContext): CookieEntry[];
  cookieHeaderForUrl(urlStr: string, ctx?: RequestContext): string | null;
  /** Stores a valid Set-Cookie value; returns `null` when input or policy rejects it. */
  setFromHeader(urlStr: string, setCookieHeader: string): CookieEntry | null;
  /** Stores a script write; it cannot create or replace an HttpOnly cookie. */
  setFromDocumentCookie(urlStr: string, raw: string): CookieEntry | null;
  /** Returns the script-visible cookie string; HttpOnly cookies are omitted. */
  documentCookieString(urlStr: string): string;
  getAll(): CookieEntry[];
  remove(opts: { name: string; url?: string; domain?: string; path?: string }): number;
  clear(): void;
}

export function createCookieJar(): CookieJar {
  const byHost = new Map<string, CookieEntry[]>();

  let warned = false;
  function warnOnce(msg: string): void {
    if (warned) return;
    warned = true;
    console.warn(`[kitesurf-cookies] ${msg}`);
  }

  function purgeExpired(host: string): void {
    const list = byHost.get(host);
    if (!list) return;
    const now = Date.now();
    const kept = list.filter((c) => c.expiresAt == null || c.expiresAt > now);
    if (kept.length !== list.length) {
      if (kept.length === 0) byHost.delete(host);
      else byHost.set(host, kept);
    }
  }

  function totalEntries(): number {
    let n = 0;
    for (const list of byHost.values()) n += list.length;
    return n;
  }

  function purgeAllExpired(): void {
    for (const host of [...byHost.keys()]) purgeExpired(host);
  }

  function entryBytes(entry: CookieEntry): number {
    return entry.name.length + entry.value.length + entry.path.length;
  }

  function replaceExisting(entry: CookieEntry, list: CookieEntry[], idx: number): void {
    entry.createdAt = list[idx]!.createdAt;
    list[idx] = entry;
  }

  function insertNew(entry: CookieEntry, list: CookieEntry[]): boolean {
    if (totalEntries() >= MAX_COOKIES_TOTAL) purgeAllExpired();
    if (totalEntries() >= MAX_COOKIES_TOTAL) {
      warnOnce(`jar at ${MAX_COOKIES_TOTAL} cookies; refusing ${entry.name}@${entry.host}`);
      return false;
    }
    if (list.length >= MAX_COOKIES_PER_HOST) {
      list.sort((a, b) => a.createdAt - b.createdAt);
      list.splice(0, list.length - MAX_COOKIES_PER_HOST + 1);
    }
    list.push(entry);
    return true;
  }

  function upsert(entry: CookieEntry): CookieEntry | null {
    if (entryBytes(entry) > MAX_COOKIE_BYTES) {
      warnOnce(`cookie over ${MAX_COOKIE_BYTES} bytes refused (${entry.name})`);
      return null;
    }
    purgeExpired(entry.host);
    const list = byHost.get(entry.host) ?? [];
    const idx = list.findIndex(
      (c) => c.name === entry.name && c.path === entry.path && c.hostOnly === entry.hostOnly,
    );
    if (idx >= 0) {
      replaceExisting(entry, list, idx);
    } else if (!insertNew(entry, list)) {
      return null;
    }
    byHost.set(entry.host, list);
    return entry;
  }

  function pathMatches(cookiePath: string, requestPath: string): boolean {
    if (cookiePath === requestPath) return true;
    if (requestPath.startsWith(cookiePath)) {
      if (cookiePath.endsWith("/")) return true;
      if (requestPath.charAt(cookiePath.length) === "/") return true;
    }
    return false;
  }

  function isLocalhost(host: string): boolean {
    return host === "localhost" || host.endsWith(".localhost");
  }

  function isIpv6Loopback(host: string): boolean {
    return host === "[::1]" || host === "::1";
  }

  function isTrustworthy(host: string, httpsScheme: boolean): boolean {
    return (
      httpsScheme ||
      isLocalhost(host) ||
      isIpv6Loopback(host) ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
    );
  }

  function urlParts(
    urlStr: string,
  ): { host: string; path: string; secure: boolean; trustworthy: boolean } | null {
    try {
      const u = new URL(urlStr);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      const host = u.hostname.toLowerCase();
      const secure = u.protocol === "https:";
      return {
        host,
        path: u.pathname || "/",
        secure,
        trustworthy: isTrustworthy(host, secure),
      };
    } catch {
      return null;
    }
  }

  function domainMatches(cookieHost: string, host: string): boolean {
    if (cookieHost === host) return true;
    return host.endsWith(`.${cookieHost}`);
  }

  function isDisallowedDomainClaim(domain: string, host: string): boolean {
    return (
      isIpHost(host) || isIpHost(domain) || !domainMatches(domain, host) || isPublicSuffix(domain)
    );
  }

  function resolveDomain(claimed: string, host: string): string | null {
    const domain = claimed.toLowerCase().replace(/^\./, "").replace(/\.$/, "");
    if (!domain) return null;
    if (domain === host) return domain;
    if (isDisallowedDomainClaim(domain, host)) return null;
    return domain;
  }

  function appendParentEntries(out: CookieEntry[], host: string): void {
    const labels = host.split(".");
    for (let i = 1; i < labels.length - 1; i++) {
      const parent = labels.slice(i).join(".");
      purgeExpired(parent);
      for (const cookie of byHost.get(parent) ?? []) {
        if (!cookie.hostOnly) out.push(cookie);
      }
    }
  }

  function candidateEntries(host: string): CookieEntry[] {
    purgeExpired(host);
    const out: CookieEntry[] = [...(byHost.get(host) ?? [])];
    if (isIpHost(host)) return out;
    appendParentEntries(out, host);
    return out;
  }

  function getForUrl(urlStr: string, ctx?: RequestContext): CookieEntry[] {
    const parts = urlParts(urlStr);
    if (!parts) return [];
    const crossSite =
      ctx !== undefined &&
      (ctx.initiatorHost === null ||
        siteKey(ctx.initiatorHost.toLowerCase()) !== siteKey(parts.host));
    const strictOnly = crossSite && ctx?.topLevel === true;
    const matched = candidateEntries(parts.host).filter((c) => {
      if (strictOnly && c.sameSite === "Strict") return false;
      if (crossSite && !strictOnly && c.sameSite !== "None") return false;
      if (c.secure && !parts.trustworthy) return false;
      if (!pathMatches(c.path, parts.path)) return false;
      return true;
    });
    matched.sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt);
    return matched;
  }

  function cookieHeaderForUrl(urlStr: string, ctx?: RequestContext): string | null {
    const cookies = getForUrl(urlStr, ctx);
    if (cookies.length === 0) return null;
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  function isValidCookieName(s: string): boolean {
    if (!s) return false;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      if (!isValidCookieNameByte(ch)) return false;
    }
    return true;
  }

  function isValidCookieNameByte(ch: number): boolean {
    return ch >= 0x21 && ch <= 0x7e && !isForbiddenCookieNameByte(ch);
  }

  function isForbiddenCookieNameByte(ch: number): boolean {
    return (ch >= 0x3a && ch <= 0x40) || FORBIDDEN_COOKIE_NAME_BYTES.has(ch);
  }

  function unquoteCookieValue(value: string): string {
    if (
      value.length >= 2 &&
      value.charCodeAt(0) === 0x22 &&
      value.charCodeAt(value.length - 1) === 0x22
    ) {
      return value.slice(1, -1);
    }
    return value;
  }

  function isForbiddenCookieValueByte(ch: number): boolean {
    return ch < 0x21 || ch > 0x7e || FORBIDDEN_COOKIE_VALUE_BYTES.has(ch);
  }

  function isValidCookieValue(s: string): boolean {
    const v = unquoteCookieValue(s);
    for (let i = 0; i < v.length; i++) {
      const ch = v.charCodeAt(i);
      if (isForbiddenCookieValueByte(ch)) return false;
    }
    return true;
  }

  function parseSetCookie(raw: string): {
    name: string;
    value: string;
    attrs: Map<string, string>;
  } | null {
    if (!raw) return null;
    const segments = raw
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    const first = segments[0];
    if (first === undefined) return null;
    const eq = first.indexOf("=");
    if (eq < 0) return null;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) return null;
    if (!isValidCookieName(name)) return null;
    if (!isValidCookieValue(value)) return null;
    const attrs = new Map<string, string>();
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      if (seg === undefined) continue;
      const eq2 = seg.indexOf("=");
      if (eq2 < 0) {
        attrs.set(seg.toLowerCase(), "");
      } else {
        attrs.set(seg.slice(0, eq2).trim().toLowerCase(), seg.slice(eq2 + 1).trim());
      }
    }
    return { name, value, attrs };
  }

  function buildEntry(
    parsed: { name: string; value: string; attrs: Map<string, string> },
    host: string,
    hostOnly: boolean,
  ): CookieEntry {
    const a = parsed.attrs;
    const path = a.get("path") || "/";
    const secure = a.has("secure");
    const httpOnly = a.has("httponly");
    const ssRaw = (a.get("samesite") || "").toLowerCase();
    const sameSite = parseSameSite(ssRaw);
    const expiresAt = cookieExpiry(a);
    return {
      name: parsed.name,
      value: parsed.value,
      host,
      path,
      secure,
      httpOnly,
      sameSite,
      hostOnly,
      expiresAt,
      createdAt: Date.now(),
    };
  }

  function parseSameSite(value: string): CookieEntry["sameSite"] {
    switch (value) {
      case "strict":
        return "Strict";
      case "lax":
        return "Lax";
      case "none":
        return "None";
      default:
        return null;
    }
  }

  function cookieExpiry(attrs: Map<string, string>): number | null {
    if (attrs.has("max-age")) return maxAgeExpiry(attrs);
    if (attrs.has("expires")) return expiresAttributeExpiry(attrs);
    return null;
  }

  function maxAgeExpiry(attrs: Map<string, string>): number | null {
    const maxAge = Number(attrs.get("max-age"));
    return Number.isFinite(maxAge) ? Date.now() + maxAge * MILLISECONDS_PER_SECOND : null;
  }

  function expiresAttributeExpiry(attrs: Map<string, string>): number | null {
    const expiresAt = Date.parse(attrs.get("expires") || "");
    return Number.isFinite(expiresAt) ? expiresAt : null;
  }

  function securePrefixHolds(
    parsed: { name: string; attrs: Map<string, string> },
    parts: { trustworthy: boolean },
  ): boolean {
    if (!parsed.name.startsWith("__Secure-")) return true;
    return parsed.attrs.has("secure") && parts.trustworthy;
  }

  function hostPrefixHolds(
    parsed: { name: string; attrs: Map<string, string> },
    parts: { trustworthy: boolean },
  ): boolean {
    if (!parsed.name.startsWith("__Host-")) return true;
    return (
      hostPrefixSecurityHolds(parsed.attrs, parts) &&
      hostPrefixDomainHolds(parsed.attrs) &&
      hostPrefixPathHolds(parsed.attrs)
    );
  }

  function hostPrefixSecurityHolds(
    attrs: Map<string, string>,
    parts: { trustworthy: boolean },
  ): boolean {
    return attrs.has("secure") && parts.trustworthy;
  }

  function hostPrefixDomainHolds(attrs: Map<string, string>): boolean {
    const domain = attrs.get("domain");
    return domain === undefined || domain === "";
  }

  function hostPrefixPathHolds(attrs: Map<string, string>): boolean {
    return (attrs.get("path") || "/") === "/";
  }

  function prefixInvariantsHold(
    parsed: { name: string; attrs: Map<string, string> },
    parts: { trustworthy: boolean },
  ): boolean {
    return securePrefixHolds(parsed, parts) && hostPrefixHolds(parsed, parts);
  }

  function existing(entry: CookieEntry): CookieEntry | undefined {
    return (byHost.get(entry.host) ?? []).find(
      (c) => c.name === entry.name && c.path === entry.path && c.hostOnly === entry.hostOnly,
    );
  }

  function resolveCookieHost(
    parsed: { attrs: Map<string, string> },
    host: string,
  ): { host: string; hostOnly: boolean } | null {
    const claimed = parsed.attrs.get("domain");
    let resolvedHost = host;
    let hostOnly = true;
    if (claimed !== undefined && claimed !== "") {
      const resolved = resolveDomain(claimed, host);
      if (resolved === null) return null;
      resolvedHost = resolved;
      hostOnly = isPublicSuffix(resolved);
    }
    return { host: resolvedHost, hostOnly };
  }

  function otherCookieAttributesAllowed(
    parsed: { name: string; attrs: Map<string, string> },
    parts: { trustworthy: boolean },
  ): boolean {
    if (!prefixInvariantsHold(parsed, parts)) return false;
    if (parsed.attrs.has("secure") && !parts.trustworthy) return false;
    return !hasInsecureSameSiteNone(parsed.attrs);
  }

  function hasInsecureSameSiteNone(attrs: Map<string, string>): boolean {
    return (attrs.get("samesite") || "").toLowerCase() === "none" && !attrs.has("secure");
  }

  function isShadowedByHttpOnly(entry: CookieEntry, requestHost: string): boolean {
    return candidateEntries(requestHost).some(
      (cookie) => cookie.name === entry.name && cookie.httpOnly,
    );
  }

  function canReplaceExisting(
    previous: CookieEntry,
    fromScript: boolean,
    trustworthy: boolean,
  ): boolean {
    return !(fromScript && previous.httpOnly) && !(previous.secure && !trustworthy);
  }

  function prepareCookieEntry(
    parsed: { name: string; value: string; attrs: Map<string, string> },
    parts: { host: string; trustworthy: boolean },
  ): CookieEntry | null {
    const host = resolveCookieHost(parsed, parts.host);
    if (!host) return null;
    if (!otherCookieAttributesAllowed(parsed, parts)) return null;
    return buildEntry(parsed, host.host, host.hostOnly);
  }

  function storeCookieEntry(
    entry: CookieEntry,
    parts: { host: string; trustworthy: boolean },
    fromScript: boolean,
  ): CookieEntry | null {
    if (fromScript) entry.httpOnly = false;
    if (isShadowedScriptCookie(entry, parts.host, fromScript)) return null;
    const previous = existing(entry);
    if (cannotReplaceCookie(previous, fromScript, parts.trustworthy)) return null;
    return upsert(entry);
  }

  function isShadowedScriptCookie(entry: CookieEntry, host: string, fromScript: boolean): boolean {
    return fromScript && isShadowedByHttpOnly(entry, host);
  }

  function cannotReplaceCookie(
    previous: CookieEntry | undefined,
    fromScript: boolean,
    trustworthy: boolean,
  ): boolean {
    return previous !== undefined && !canReplaceExisting(previous, fromScript, trustworthy);
  }

  function storePreparedCookie(
    parsed: { name: string; value: string; attrs: Map<string, string> },
    parts: { host: string; trustworthy: boolean },
    fromScript: boolean,
  ): CookieEntry | null {
    const entry = prepareCookieEntry(parsed, parts);
    if (!entry) return null;
    return storeCookieEntry(entry, parts, fromScript);
  }

  function store(urlStr: string, raw: string, fromScript: boolean): CookieEntry | null {
    const parts = urlParts(urlStr);
    if (!parts) return null;
    const parsed = parseSetCookie(raw);
    if (!parsed) return null;
    return storePreparedCookie(parsed, parts, fromScript);
  }

  function setFromHeader(urlStr: string, raw: string): CookieEntry | null {
    return store(urlStr, raw, false);
  }

  function setFromDocumentCookie(urlStr: string, raw: string): CookieEntry | null {
    return store(urlStr, raw, true);
  }

  function documentCookieString(urlStr: string): string {
    const parts = urlParts(urlStr);
    if (!parts) return "";
    const visible = candidateEntries(parts.host).filter((c) => {
      if (c.httpOnly) return false;
      if (c.secure && !parts.trustworthy) return false;
      if (!pathMatches(c.path, parts.path)) return false;
      return true;
    });
    visible.sort((a, b) => b.path.length - a.path.length || a.createdAt - b.createdAt);
    return visible.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  function getAll(): CookieEntry[] {
    const out: CookieEntry[] = [];
    const now = Date.now();
    for (const list of byHost.values()) {
      for (const c of list) {
        if (c.expiresAt == null || c.expiresAt > now) out.push(c);
      }
    }
    return out;
  }

  function remove(opts: { name: string; url?: string; domain?: string; path?: string }): number {
    const wantName = opts.name;
    let host: string | undefined;
    if (opts.domain) host = opts.domain.toLowerCase().replace(/^\./, "");
    else if (opts.url) {
      const parts = urlParts(opts.url);
      if (parts) host = parts.host;
    }
    const wantPath = opts.path;
    let removed = 0;
    const removeFromHost = (key: string, list: CookieEntry[]): void => {
      const kept = list.filter((c) => {
        if (c.name !== wantName) return true;
        if (wantPath !== undefined && c.path !== wantPath) return true;
        removed++;
        return false;
      });
      if (kept.length === 0) byHost.delete(key);
      else byHost.set(key, kept);
    };
    if (host) {
      const list = byHost.get(host);
      if (!list) return 0;
      removeFromHost(host, list);
    } else {
      for (const [key, list] of byHost) removeFromHost(key, list);
    }
    return removed;
  }

  function clear(): void {
    byHost.clear();
  }

  return {
    getForUrl,
    cookieHeaderForUrl,
    setFromHeader,
    setFromDocumentCookie,
    documentCookieString,
    getAll,
    remove,
    clear,
  };
}

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export function entryToCdp(c: CookieEntry): CdpCookie {
  const out: CdpCookie = {
    name: c.name,
    value: c.value,
    domain: c.hostOnly ? c.host : `.${c.host}`,
    path: c.path,
    expires: c.expiresAt == null ? -1 : Math.floor(c.expiresAt / MILLISECONDS_PER_SECOND),
    size: c.name.length + c.value.length,
    httpOnly: c.httpOnly,
    secure: c.secure,
    session: c.expiresAt == null,
  };
  if (c.sameSite) out.sameSite = c.sameSite;
  return out;
}

export interface CdpCookieParam {
  name?: string;
  value?: string;
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expires?: number;
}

export function parseCdpCookieParam(raw: unknown): CdpCookieParam | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r: Record<string, unknown> = { ...raw };
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  return {
    name: str(r.name),
    value: str(r.value),
    url: str(r.url),
    domain: str(r.domain),
    path: str(r.path),
    secure: bool(r.secure),
    httpOnly: bool(r.httpOnly),
    sameSite: str(r.sameSite),
    expires: typeof r.expires === "number" && Number.isFinite(r.expires) ? r.expires : undefined,
  };
}

function cdpCookieUrl(param: CdpCookieParam): string {
  const domain = param.domain?.toLowerCase() ?? "";
  return param.url ?? (domain ? `https://${domain.replace(/^\./, "")}/` : "");
}

function appendCdpPathAndDomain(param: CdpCookieParam, segments: string[]): void {
  if (param.path) segments.push(`Path=${param.path}`);
  if (param.domain?.startsWith(".")) segments.push(`Domain=${param.domain.toLowerCase()}`);
}

function appendCdpSecurityFlags(param: CdpCookieParam, segments: string[]): void {
  if (param.secure === true) segments.push("Secure");
  if (param.httpOnly === true) segments.push("HttpOnly");
}

function appendCdpSameSiteAndExpiry(param: CdpCookieParam, segments: string[]): void {
  if (param.sameSite) segments.push(`SameSite=${param.sameSite}`);
  if (typeof param.expires === "number" && param.expires > 0) {
    segments.push(`Expires=${new Date(param.expires * MILLISECONDS_PER_SECOND).toUTCString()}`);
  }
}

export function setCdpCookie(jar: CookieJar, raw: unknown): CookieEntry | null {
  const p = parseCdpCookieParam(raw);
  if (!p?.name) return null;
  const url = cdpCookieUrl(p);
  if (!url) return null;
  const segs: string[] = [`${p.name}=${p.value ?? ""}`];
  appendCdpPathAndDomain(p, segs);
  appendCdpSecurityFlags(p, segs);
  appendCdpSameSiteAndExpiry(p, segs);
  return jar.setFromHeader(url, segs.join("; "));
}
