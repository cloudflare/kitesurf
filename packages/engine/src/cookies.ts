// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Stores page cookies and selects entries for requests and document.cookie reads.

import { isIpHost, isPublicSuffix, schemefulSite } from "./public-suffix.ts";

const MAX_COOKIE_BYTES = 4096;
const MAX_COOKIES_PER_HOST = 180;
const MAX_COOKIES_TOTAL = 3000;
const MILLISECONDS_PER_SECOND = 1_000;

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
  initiatorOrigin: string | null;
  topLevel?: boolean;
  method?: string;
}

export interface CookieJar {
  /** Returns cookies matching the URL and optional SameSite request context. */
  getForUrl(urlStr: string, ctx?: RequestContext): CookieEntry[];
  cookieHeaderForUrl(urlStr: string, ctx?: RequestContext): string | null;
  /** Stores a valid Set-Cookie value; returns `null` when input or policy rejects it. */
  setFromHeader(urlStr: string, setCookieHeader: string, ctx?: RequestContext): CookieEntry | null;
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

  function upsert(entry: CookieEntry, trustworthy: boolean): CookieEntry | null {
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
      entry.createdAt = list[idx]!.createdAt;
      list[idx] = entry;
    } else {
      if (totalEntries() >= MAX_COOKIES_TOTAL) {
        purgeAllExpired();
      }
      if (totalEntries() >= MAX_COOKIES_TOTAL) {
        warnOnce(`jar at ${MAX_COOKIES_TOTAL} cookies; refusing ${entry.name}@${entry.host}`);
        return null;
      }
      if (list.length >= MAX_COOKIES_PER_HOST) {
        const nonSecure = list.filter((c) => !c.secure);
        if (nonSecure.length === 0 && !trustworthy) return null;
        const candidates = nonSecure.length ? nonSecure : list;
        const oldest = candidates.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b));
        list.splice(list.indexOf(oldest), 1);
      }
      list.push(entry);
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

  function isTrustworthy(host: string, httpsScheme: boolean): boolean {
    if (httpsScheme) return true;
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    if (host === "[::1]" || host === "::1") return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
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

  function resolveDomain(claimed: string, host: string): string | null {
    const raw = claimed.toLowerCase().replace(/^\./, "").replace(/\.$/, "");
    if (!raw) return null;
    if (raw === host) return raw;
    if (isIpHost(host) || /[\\/\s:@?#%\[\]]/u.test(raw)) return null;
    let d: string;
    try {
      d = new URL(`http://${raw}/`).hostname.replace(/\.$/, "");
    } catch {
      return null;
    }
    if (d === host) return d;
    if (isIpHost(d) || !domainMatches(d, host) || isPublicSuffix(d)) return null;
    return d;
  }

  function candidateEntries(host: string): CookieEntry[] {
    purgeExpired(host);
    const out: CookieEntry[] = [...(byHost.get(host) ?? [])];
    if (isIpHost(host)) return out;
    const labels = host.split(".");
    for (let i = 1; i < labels.length - 1; i++) {
      const parent = labels.slice(i).join(".");
      purgeExpired(parent);
      for (const c of byHost.get(parent) ?? []) {
        if (!c.hostOnly) out.push(c);
      }
    }
    return out;
  }

  function getForUrl(urlStr: string, ctx?: RequestContext): CookieEntry[] {
    const parts = urlParts(urlStr);
    if (!parts) return [];
    const initiatorSite = ctx?.initiatorOrigin ? schemefulSite(ctx.initiatorOrigin) : null;
    const targetSite = schemefulSite(urlStr);
    const crossSite =
      ctx !== undefined &&
      (initiatorSite === null || targetSite === null || initiatorSite !== targetSite);
    const safeTopLevel =
      ctx?.topLevel === true &&
      ["GET", "HEAD", "OPTIONS", "TRACE"].includes((ctx.method ?? "GET").toUpperCase());
    const matched = candidateEntries(parts.host).filter((c) => {
      if (crossSite && c.sameSite === "Strict") return false;
      if (crossSite && !safeTopLevel && c.sameSite !== "None") return false;
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
      if (ch < 0x21 || ch > 0x7e) return false;
      if (ch === 0x28 || ch === 0x29 || ch === 0x2c || ch === 0x2f) return false;
      if (ch >= 0x3a && ch <= 0x40) return false;
      if (ch === 0x5b || ch === 0x5c || ch === 0x5d) return false;
      if (ch === 0x7b || ch === 0x7d) return false;
      if (ch === 0x22) return false;
    }
    return true;
  }
  function isValidCookieValue(s: string): boolean {
    let v = s;
    if (v.length >= 2 && v.charCodeAt(0) === 0x22 && v.charCodeAt(v.length - 1) === 0x22) {
      v = v.slice(1, -1);
    }
    for (let i = 0; i < v.length; i++) {
      const ch = v.charCodeAt(i);
      if (ch < 0x21 || ch > 0x7e) return false;
      if (ch === 0x22 || ch === 0x2c || ch === 0x3b || ch === 0x5c) return false;
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
    const sameSite =
      ssRaw === "strict" ? "Strict" : ssRaw === "lax" ? "Lax" : ssRaw === "none" ? "None" : null;
    let expiresAt: number | null = null;
    if (a.has("max-age")) {
      const ma = Number(a.get("max-age"));
      if (Number.isFinite(ma)) {
        expiresAt = Date.now() + ma * MILLISECONDS_PER_SECOND;
      }
    } else if (a.has("expires")) {
      const t = Date.parse(a.get("expires") || "");
      if (Number.isFinite(t)) expiresAt = t;
    }
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

  function prefixInvariantsHold(
    parsed: { name: string; attrs: Map<string, string> },
    parts: { trustworthy: boolean },
  ): boolean {
    const secure = parsed.attrs.has("secure");
    if (parsed.name.startsWith("__Secure-")) {
      if (!secure || !parts.trustworthy) return false;
    }
    if (parsed.name.startsWith("__Host-")) {
      if (!secure || !parts.trustworthy) return false;
      const d = parsed.attrs.get("domain");
      if (d !== undefined && d !== "") return false;
      if ((parsed.attrs.get("path") || "/") !== "/") return false;
    }
    return true;
  }

  // A script write must not shadow an HttpOnly cookie on any host the new
  // cookie reaches. `candidateEntries` misses a host-only HttpOnly cookie on a
  // parent or sibling that a Domain write would also reach, so compare the
  // send sets directly.
  function shadowsHttpOnly(entry: CookieEntry): boolean {
    for (const c of getAll()) {
      if (c.name !== entry.name || !c.httpOnly) continue;
      if (entry.hostOnly) {
        // The new cookie goes to entry.host only.
        if (c.hostOnly ? c.host === entry.host : domainMatches(c.host, entry.host)) {
          return true;
        }
      } else {
        // The new Domain cookie goes to entry.host and every subdomain. The
        // existing cookie reaches a host in that set when either domain is a
        // suffix of the other, or it is host-only under the new domain.
        if (
          c.hostOnly
            ? domainMatches(entry.host, c.host)
            : domainMatches(entry.host, c.host) || domainMatches(c.host, entry.host)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  function existing(entry: CookieEntry): CookieEntry | undefined {
    return (byHost.get(entry.host) ?? []).find(
      (c) => c.name === entry.name && c.path === entry.path && c.hostOnly === entry.hostOnly,
    );
  }

  function store(
    urlStr: string,
    raw: string,
    fromScript: boolean,
    ctx?: RequestContext,
  ): CookieEntry | null {
    const parts = urlParts(urlStr);
    if (!parts) return null;
    const parsed = parseSetCookie(raw);
    if (!parsed) return null;

    const claimed = parsed.attrs.get("domain");
    let host = parts.host;
    let hostOnly = true;
    if (claimed !== undefined && claimed !== "") {
      const resolved = resolveDomain(claimed, parts.host);
      if (resolved === null) return null;
      host = resolved;
      hostOnly = isPublicSuffix(resolved);
    }

    if (!prefixInvariantsHold(parsed, parts)) return null;

    if (parsed.attrs.has("secure") && !parts.trustworthy) return null;

    if (
      (parsed.attrs.get("samesite") || "").toLowerCase() === "none" &&
      !parsed.attrs.has("secure")
    ) {
      return null;
    }

    const entry = buildEntry(parsed, host, hostOnly);
    if (ctx !== undefined && ctx.topLevel !== true && entry.sameSite !== "None") {
      const sourceSite = ctx.initiatorOrigin ? schemefulSite(ctx.initiatorOrigin) : null;
      const targetSite = schemefulSite(urlStr);
      if (sourceSite === null || targetSite === null || sourceSite !== targetSite) return null;
    }
    if (fromScript) entry.httpOnly = false;

    if (fromScript && shadowsHttpOnly(entry)) return null;

    if (
      !parts.trustworthy &&
      getAll().some(
        (c) =>
          c.secure &&
          c.name === entry.name &&
          (domainMatches(c.host, entry.host) || domainMatches(entry.host, c.host)) &&
          pathMatches(c.path, entry.path),
      )
    ) {
      return null;
    }
    const prev = existing(entry);
    if (prev && fromScript && prev.httpOnly) return null;
    return upsert(entry, parts.trustworthy);
  }

  function setFromHeader(urlStr: string, raw: string, ctx?: RequestContext): CookieEntry | null {
    return store(urlStr, raw, false, ctx);
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
    if (host) {
      const list = byHost.get(host);
      if (!list) return 0;
      const kept = list.filter((c) => {
        if (c.name !== wantName) return true;
        if (wantPath !== undefined && c.path !== wantPath) return true;
        removed++;
        return false;
      });
      if (kept.length === 0) byHost.delete(host);
      else byHost.set(host, kept);
    } else {
      for (const [h, list] of byHost) {
        const kept = list.filter((c) => {
          if (c.name !== wantName) return true;
          if (wantPath !== undefined && c.path !== wantPath) return true;
          removed++;
          return false;
        });
        if (kept.length === 0) byHost.delete(h);
        else byHost.set(h, kept);
      }
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

export function setCdpCookie(jar: CookieJar, raw: unknown): CookieEntry | null {
  const p = parseCdpCookieParam(raw);
  if (!p?.name) return null;
  const domain = p.domain?.toLowerCase() ?? "";
  const url = p.url ?? (domain ? `https://${domain.replace(/^\./, "")}/` : "");
  if (!url) return null;
  const segs: string[] = [`${p.name}=${p.value ?? ""}`];
  if (p.path) segs.push(`Path=${p.path}`);
  if (domain.startsWith(".")) segs.push(`Domain=${domain}`);
  if (p.secure === true) segs.push("Secure");
  if (p.httpOnly === true) segs.push("HttpOnly");
  if (p.sameSite) segs.push(`SameSite=${p.sameSite}`);
  if (typeof p.expires === "number" && p.expires > 0) {
    segs.push(`Expires=${new Date(p.expires * MILLISECONDS_PER_SECOND).toUTCString()}`);
  }
  return jar.setFromHeader(url, segs.join("; "));
}
