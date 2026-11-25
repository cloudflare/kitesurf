// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Prefetches render-blocking <link rel="stylesheet"> resources during Page.navigate
// in parallel with script prefetching and module walking, handing completed responses
// once to PageScript's session outbound.

import type { SessionOutboundRequest } from "@kitesurf/jsrpc-types/page-script";
import { getInterception, interceptionMatches } from "../cdp/fetch-interception.ts";
import {
  declaredOverCap,
  MAX_CONNECTION_READ_BYTES,
  MAX_STYLESHEET_BYTES,
  readCappedBudgeted,
} from "../read-capped.ts";
import { rpcSafeResponse, type SandboxOutboundOverride } from "./outbound.ts";

const MAX_PREFETCH_STYLESHEETS = 24;
const MAX_PRELOAD_SCRIPTS = 48;
const MAX_PREFETCH_TOTAL_BYTES = 4 * 1024 * 1024;
const MAX_PREFETCH_CONCURRENCY = 8;
const PREFETCH_TIMEOUT_MS = 10_000;
const MAX_SCAN_HTML_CHARS = 4 * 1024 * 1024;

export interface ScannedStylesheetLink {
  url: string;
  corsMode: "cors" | "no-cors";
}

export interface PrefetchedStylesheets {
  take(req: SessionOutboundRequest): Promise<Response | null> | null;
  cancel(): void;
}

type CachedStylesheet =
  | {
      status: number;
      headers: Array<[string, string]>;
      bytes: Uint8Array;
      stream: null;
    }
  | {
      status: number;
      headers: Array<[string, string]>;
      bytes: null;
      stream: ReadableStream<Uint8Array>;
    };

function extractStylesheetHeaders(resp: Response): Array<[string, string]> {
  const respHeaders: Array<[string, string]> = [];
  resp.headers.forEach((v, k) => {
    const lowerKey = k.toLowerCase();
    if (lowerKey === "set-cookie" || lowerKey === "set-cookie2") return;
    respHeaders.push([k, v]);
  });
  return respHeaders;
}

const NAMED_HTML_REFS = new Map([
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
]);

// One pass, like the HTML tokenizer: a reference produced by decoding is never rescanned, so
// `&#38;amp;` decodes to `&amp;` and not to `&`.
function decodeHtmlAttr(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(
    /&(?:#(?:x([0-9a-fA-F]+)|([0-9]+))|amp|lt|gt|quot);/g,
    (match, hex?: string, dec?: string) => {
      if (hex !== undefined || dec !== undefined) {
        const cp = hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec ?? "", 10);
        if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff) return match;
        try {
          return String.fromCodePoint(cp);
        } catch {
          return match;
        }
      }
      return NAMED_HTML_REFS.get(match) ?? match;
    },
  );
}

function parseLinkAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let pos = 5; // skip "<link"
  const len = tag.length;
  while (pos < len) {
    while (pos < len && /[\s/]/.test(tag[pos] ?? "")) pos++;
    if (pos >= len || tag[pos] === ">") break;
    const nameStart = pos;
    while (pos < len && !/[\s=/>]/.test(tag[pos] ?? "")) pos++;
    const name = tag.slice(nameStart, pos).toLowerCase();
    if (!name) {
      pos++;
      continue;
    }
    while (pos < len && /\s/.test(tag[pos] ?? "")) pos++;
    let value = "";
    if (tag[pos] === "=") {
      pos++;
      while (pos < len && /\s/.test(tag[pos] ?? "")) pos++;
      const quote = tag[pos];
      if (quote === '"' || quote === "'") {
        const end = tag.indexOf(quote, pos + 1);
        if (end < 0) break;
        value = tag.slice(pos + 1, end);
        pos = end + 1;
      } else {
        const valStart = pos;
        while (pos < len && !/[\s>]/.test(tag[pos] ?? "")) pos++;
        value = tag.slice(valStart, pos);
      }
    }
    if (!attrs.has(name)) attrs.set(name, decodeHtmlAttr(value));
  }
  return attrs;
}

function isRenderBlockingMedia(media: string | undefined): boolean {
  if (!media) return true;
  const trimmed = media.trim().toLowerCase();
  return trimmed === "" || trimmed === "all" || trimmed === "screen";
}

function normalizeCrossOrigin(raw: string | undefined): "cors" | "no-cors" {
  // Matches blitz-dom's ks-cors parameter: any crossorigin attribute selects "cors",
  // while its absence selects "no-cors".
  return raw === undefined ? "no-cors" : "cors";
}

function skipTagBlock(html: string, lower: string, from: number, closeTag: string): number {
  const end = lower.indexOf(closeTag, from);
  if (end < 0) return html.length;
  const gt = html.indexOf(">", end + closeTag.length - 1);
  return gt < 0 ? html.length : gt + 1;
}

function findTagEnd(html: string, from: number): number {
  let pos = from;
  const len = html.length;
  while (pos < len) {
    const ch = html[pos];
    if (ch === ">") return pos;
    if (ch === '"' || ch === "'") {
      const end = html.indexOf(ch, pos + 1);
      if (end < 0) return -1;
      pos = end + 1;
      continue;
    }
    pos++;
  }
  return -1;
}

const RAW_BLOCK_TAGS: ReadonlyArray<readonly [string, string]> = [
  ["<script", "</script"],
  ["<style", "</style"],
  ["<noscript", "</noscript"],
  ["<textarea", "</textarea"],
  ["<title", "</title"],
  ["<xmp", "</xmp"],
  ["<iframe", "</iframe"],
  ["<noembed", "</noembed"],
  ["<noframes", "</noframes"],
  ["<plaintext", "</plaintext"],
];

function skipTemplateBlock(html: string, lower: string, from: number): number {
  let depth = 1;
  let pos = from;
  while (pos < html.length && depth > 0) {
    const lt = html.indexOf("<", pos);
    if (lt < 0) return html.length;
    if (lower.startsWith("<template", lt) && /[\s/>]/.test(lower[lt + 9] ?? "")) {
      const gt = findTagEnd(html, lt + 9);
      if (gt < 0) return html.length;
      depth++;
      pos = gt + 1;
      continue;
    }
    if (lower.startsWith("</template", lt) && /[\s/>]/.test(lower[lt + 10] ?? "")) {
      const gt = html.indexOf(">", lt + 10);
      if (gt < 0) return html.length;
      depth--;
      pos = gt + 1;
      continue;
    }
    pos = lt + 1;
  }
  return pos;
}

function forEachLinkTag(html: string, visit: (attrs: Map<string, string>) => boolean | void): void {
  if (html.length === 0 || html.length > MAX_SCAN_HTML_CHARS) return;
  const lower = html.toLowerCase();
  let pos = 0;

  while (pos < html.length) {
    const lt = html.indexOf("<", pos);
    if (lt < 0) break;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      pos = end < 0 ? html.length : end + 3;
      continue;
    }
    if (lower.startsWith("<template", lt) && /[\s/>]/.test(lower[lt + 9] ?? "")) {
      const gt = findTagEnd(html, lt + 9);
      pos = gt < 0 ? html.length : skipTemplateBlock(html, lower, gt + 1);
      continue;
    }
    let skippedBlock = false;
    for (const [openTag, closeTag] of RAW_BLOCK_TAGS) {
      if (lower.startsWith(openTag, lt) && /[\s/>]/.test(lower[lt + openTag.length] ?? "")) {
        pos = skipTagBlock(html, lower, lt + openTag.length, closeTag);
        skippedBlock = true;
        break;
      }
    }
    if (skippedBlock) continue;

    const isLink = lower.startsWith("<link", lt) && /[\s/>]/.test(lower[lt + 5] ?? "");
    const gt = findTagEnd(html, lt + 1);
    if (gt < 0) break;
    pos = gt + 1;
    if (!isLink) continue;

    if (visit(parseLinkAttributes(html.slice(lt, gt + 1))) === false) break;
  }
}

function resolveHttpLinkUrl(href: string | undefined, baseUrl: string): string | null {
  const trimmed = href?.trim();
  if (!trimmed) return null;
  let resolved: URL;
  try {
    resolved = new URL(trimmed, baseUrl);
  } catch {
    return null;
  }
  if (
    (resolved.protocol !== "http:" && resolved.protocol !== "https:") ||
    resolved.hostname === "kitesurf.local"
  ) {
    return null;
  }
  return resolved.href;
}

/**
 * Extracts render-blocking `<link rel="stylesheet">` URLs in document order, skipping
 * comments, quoted tag attributes, and rawtext/RCDATA/template/noscript blocks.
 */
export function scanStylesheetLinks(html: string, baseUrl: string): ScannedStylesheetLink[] {
  const out: ScannedStylesheetLink[] = [];
  const seen = new Set<string>();
  forEachLinkTag(html, (attrs) => {
    if (attrs.has("disabled")) return;
    const relTokens = (attrs.get("rel") ?? "").trim().toLowerCase().split(/\s+/);
    if (!relTokens.includes("stylesheet") || relTokens.includes("alternate")) return;
    if (!isRenderBlockingMedia(attrs.get("media"))) return;
    const resolved = resolveHttpLinkUrl(attrs.get("href"), baseUrl);
    if (!resolved) return;
    const corsMode = normalizeCrossOrigin(attrs.get("crossorigin"));
    const key = `${resolved}\0${corsMode}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ url: resolved, corsMode });
    if (out.length >= MAX_PREFETCH_STYLESHEETS) return false;
  });
  return out;
}

/**
 * Extracts `<link rel="preload" as="script">` URLs in document order using the same safe tag
 * scanner so runtime-inserted preloaded chunks can be speculatively baked into V8 on cold visits.
 */
export function scanPreloadScriptLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  forEachLinkTag(html, (attrs) => {
    const relTokens = (attrs.get("rel") ?? "").trim().toLowerCase().split(/\s+/);
    if (!relTokens.includes("preload")) return;
    if ((attrs.get("as") ?? "").trim().toLowerCase() !== "script") return;
    const resolved = resolveHttpLinkUrl(attrs.get("href"), baseUrl);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    out.push(resolved);
    if (out.length >= MAX_PRELOAD_SCRIPTS) return false;
  });
  return out;
}

function cspMayRestrictStyles(cspHeaders: readonly string[]): boolean {
  for (const policy of cspHeaders) {
    if (/\b(?:style-src|style-src-elem|default-src)\b/i.test(policy)) return true;
  }
  return false;
}

function requestHeader(headers: Array<[string, string]>, name: string): string {
  const lower = name.toLowerCase();
  for (const [k, v] of headers) {
    if (k.toLowerCase() === lower) return v;
  }
  return "";
}

export interface StartStylesheetPrefetchOptions {
  html: string;
  baseUrl: string;
  pageUrl: string;
  pageOrigin: string;
  connectionId: string;
  mainFrameId: string;
  mainLoaderId: string;
  extraHeaders: Record<string, string>;
  cookieKey: string;
  referrerPolicy?: string;
  cspHeaders: readonly string[];
  sandboxOutbound: SandboxOutboundOverride;
}

/**
 * Starts best-effort fetches for render-blocking `<link rel="stylesheet">` tags in parallel
 * with script prefetching and module walking. Each entry is consumed at most once.
 */
export function startStylesheetPrefetch(
  opts: StartStylesheetPrefetchOptions,
): PrefetchedStylesheets | null {
  if (cspMayRestrictStyles(opts.cspHeaders)) return null;
  const links = scanStylesheetLinks(opts.html, opts.baseUrl);
  if (links.length === 0) return null;

  const interception = opts.connectionId ? getInterception(opts.connectionId) : undefined;
  const eligible = interception
    ? links.filter((l) => !interceptionMatches(interception, l.url, "Stylesheet"))
    : links;
  if (eligible.length === 0) return null;

  const outbound = opts.sandboxOutbound.parent({
    pageOrigin: opts.pageOrigin,
    pageUrl: opts.pageUrl,
    referrerPolicy: opts.referrerPolicy,
    mainFrameId: opts.mainFrameId,
    mainLoaderId: opts.mainLoaderId,
    extraHeaders: opts.extraHeaders,
    connectionId: opts.connectionId,
    cookieKey: opts.cookieKey,
  });

  const controller = new AbortController();
  const entries = new Map<string, Promise<CachedStylesheet | null>>();
  let cancelled = false;
  let batchBytes = 0;
  let active = 0;
  const waiters: Array<() => void> = [];

  const acquireSlot = async (): Promise<boolean> => {
    if (controller.signal.aborted) return false;
    if (active < MAX_PREFETCH_CONCURRENCY) {
      active++;
      return true;
    }
    await new Promise<void>((resolve) => {
      const onAbort = () => resolve();
      controller.signal.addEventListener("abort", onAbort, { once: true });
      waiters.push(() => {
        controller.signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
    if (controller.signal.aborted) return false;
    active++;
    return true;
  };
  const releaseSlot = (): void => {
    active--;
    const next = waiters.shift();
    if (next) next();
  };

  for (const { url, corsMode } of eligible) {
    const key = `${url}\0${corsMode}`;
    const headers: Record<string, string> = {
      "x-kitesurf-resource-type": "Stylesheet",
      "x-kitesurf-initiator": "parser",
      "x-kitesurf-allow-cross-origin": "1",
      "x-kitesurf-stylesheet-cors": corsMode,
      // Match PageScript's trustedFetch default so cross-origin <link crossorigin> never sends
      // jar cookies and gets accepted under wildcard ACAO.
      "x-kitesurf-credentials": "same-origin",
    };
    if (opts.connectionId) headers["x-kitesurf-connection-id"] = opts.connectionId;
    if (opts.mainFrameId) headers["x-kitesurf-frame-id"] = opts.mainFrameId;
    if (opts.cookieKey) headers["x-kitesurf-cookie-key"] = opts.cookieKey;

    const promise = (async (): Promise<CachedStylesheet | null> => {
      if (!(await acquireSlot())) return null;
      const reqCtrl = new AbortController();
      const onParentAbort = () => reqCtrl.abort();
      controller.signal.addEventListener("abort", onParentAbort, { once: true });
      const timer = setTimeout(() => reqCtrl.abort(), PREFETCH_TIMEOUT_MS);
      let chargedBatch = 0;
      let kept = false;
      try {
        const resp = await outbound.fetch(
          new Request(url, { method: "GET", headers, redirect: "manual", signal: reqCtrl.signal }),
        );
        const respHeaders = extractStylesheetHeaders(resp);
        const readCap = Math.min(MAX_STYLESHEET_BYTES, MAX_PREFETCH_TOTAL_BYTES);
        if (declaredOverCap(resp.headers, readCap)) {
          if (cancelled) {
            await resp.body?.cancel().catch(() => {});
            return null;
          }
          if (!resp.body) {
            return {
              status: resp.status,
              headers: respHeaders,
              bytes: new Uint8Array(0),
              stream: null,
            };
          }
          return { status: resp.status, headers: respHeaders, bytes: null, stream: resp.body };
        }
        const got = await readCappedBudgeted(
          resp.body,
          readCap,
          opts.connectionId,
          MAX_CONNECTION_READ_BYTES,
          (delta) => {
            if (batchBytes + delta > MAX_PREFETCH_TOTAL_BYTES) return false;
            batchBytes += delta;
            chargedBatch += delta;
            return true;
          },
        );
        if (got.bytes !== null) {
          kept = true;
          return { status: resp.status, headers: respHeaders, bytes: got.bytes, stream: null };
        }
        if (got.failure === "error") {
          await got.rest.cancel().catch(() => {});
          return null;
        }
        // Over readCap, batch budget, or connection budget: hand the page the in-flight response
        // as a stream (replayed chunks plus unread tail) so it is never fetched a second time.
        if (cancelled) {
          await got.rest.cancel().catch(() => {});
          return null;
        }
        return { status: resp.status, headers: respHeaders, bytes: null, stream: got.rest };
      } catch {
        return null;
      } finally {
        if (!kept && chargedBatch > 0) batchBytes -= chargedBatch;
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onParentAbort);
        releaseSlot();
      }
    })();
    entries.set(key, promise);
  }

  return {
    take(req: SessionOutboundRequest): Promise<Response | null> | null {
      if (req.method !== "GET") return null;
      if (requestHeader(req.headers, "x-kitesurf-resource-type") !== "Stylesheet") return null;
      if (requestHeader(req.headers, "x-kitesurf-initiator") !== "parser") return null;
      if (requestHeader(req.headers, "x-kitesurf-credentials") !== "same-origin") return null;
      const rawCors = requestHeader(req.headers, "x-kitesurf-stylesheet-cors");
      const corsMode = rawCors === "cors" ? "cors" : "no-cors";
      const key = `${req.url}\0${corsMode}`;
      const pending = entries.get(key);
      if (!pending) return null;
      entries.delete(key);
      return pending.then((cached) => {
        if (!cached) return null;
        const body = cached.stream ?? (cached.bytes.byteLength > 0 ? cached.bytes : null);
        return rpcSafeResponse(
          new Response(body, { status: cached.status, headers: cached.headers }),
        );
      });
    },
    cancel(): void {
      cancelled = true;
      for (const pending of entries.values()) {
        void pending.then((cached) => {
          if (cached?.stream) void cached.stream.cancel().catch(() => {});
        });
      }
      entries.clear();
      controller.abort();
    },
  };
}
