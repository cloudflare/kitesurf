// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Extracts likely route chunk URLs from Next.js manifests and page script text.

import type { ParentScriptDescriptor } from "../wasm.ts";

const MANIFEST_RE = /\/_next\/static\/[^/]+\/_buildManifest\.js(?:\?.*)?$/;
const MAX_ROUTE_CHUNKS = 12;
const SKIP_ROUTES = new Set(["/_app", "/_error", "/404", "/500"]);

const MARKER = "__BUILD_MANIFEST";
const CALLBACK = "self.__BUILD_MANIFEST_CB";
const FUNCTION = "function(";
const RETURN = "return";
const SPACE = /\s/;
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/** Offset of the first code unit at or after `from` that is not JS-regex whitespace. */
function skipSpace(text: string, from: number): number {
  let cursor = from;
  while (SPACE.test(text.charAt(cursor))) cursor++;
  return cursor;
}

/**
 * Parameters of the first `__BUILD_MANIFEST=function(...){return{` header, or null.
 * Like the regexes this replaces, markers inside comments or strings still count.
 */
function functionParams(source: string): string[] | null {
  let pos = 0;
  // The first `)` at or after the last parameter list, and the one that already failed.
  let paren = -1;
  let failed = -1;
  for (;;) {
    const at = source.indexOf(MARKER, pos);
    if (at < 0) return null;
    pos = at + MARKER.length;
    let cursor = skipSpace(source, pos);
    if (source.charAt(cursor) !== "=") continue;
    cursor = skipSpace(source, cursor + 1);
    if (!source.startsWith(FUNCTION, cursor)) continue;
    const paramsStart = cursor + FUNCTION.length;
    if (paren < paramsStart) paren = source.indexOf(")", paramsStart);
    // No parameter list ends anywhere after this marker, so no later marker can match either.
    if (paren < 0) return null;
    // A `)` that failed once fails for every marker before it too, so it is checked once.
    if (paren === failed) continue;
    cursor = skipSpace(source, paren + 1);
    if (source.charAt(cursor) === "{") {
      cursor = skipSpace(source, cursor + 1);
      if (source.startsWith(RETURN, cursor)) {
        cursor = skipSpace(source, cursor + RETURN.length);
        if (source.charAt(cursor) === "{") {
          return source
            .slice(paramsStart, paren)
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);
        }
      }
    }
    failed = paren;
  }
}

/** Whether the source assigns the manifest as a plain object instead of a function call. */
function hasObjectForm(source: string): boolean {
  let pos = 0;
  for (;;) {
    const at = source.indexOf(MARKER, pos);
    if (at < 0) return false;
    pos = at + MARKER.length;
    const cursor = skipSpace(source, pos);
    if (source.charAt(cursor) !== "=") continue;
    if (source.charAt(skipSpace(source, cursor + 1)) === "{") return true;
  }
}

/** `[start, end)` of the last `}}( ... )` argument list the old greedy tail match accepted. */
function tailRange(source: string): readonly [number, number] | null {
  let open = -1;
  for (let at = source.indexOf("}"); at >= 0; at = source.indexOf("}", at + 1)) {
    const second = skipSpace(source, at + 1);
    if (source.charAt(second) !== "}") continue;
    const paren = skipSpace(source, second + 1);
    if (source.charAt(paren) === "(") {
      open = paren + 1;
      break;
    }
  }
  if (open < 0) return null;
  let end = -1;
  for (let at = source.indexOf(")", open); at >= 0; at = source.indexOf(")", at + 1)) {
    let cursor = skipSpace(source, at + 1);
    const punct = source.charAt(cursor);
    if (punct === ";" || punct === ",") cursor = skipSpace(source, cursor + 1);
    if (cursor === source.length || source.startsWith(CALLBACK, cursor)) end = at;
  }
  return end < 0 ? null : [open, end];
}

/** Parameter name -> quoted argument value, from the call the manifest function ends with. */
function tailValues(source: string, params: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  const range = tailRange(source);
  if (!range) return values;
  const [from, to] = range;
  // No unescaped closing quote starts before this offset, so a scan there fails in constant time.
  let noQuoteUntil = from;
  let pos = from;
  let index = 0;
  while (pos < to) {
    const ch = source.charAt(pos);
    if (ch === ",") {
      pos++;
      continue;
    }
    if (ch !== '"') {
      let stop = pos + 1;
      while (stop < to && source.charAt(stop) !== "," && source.charAt(stop) !== '"') stop++;
      index++;
      pos = stop;
      continue;
    }
    // An unterminated literal cannot open a match, so the quote is just a skipped character.
    if (pos < noQuoteUntil) {
      pos++;
      continue;
    }
    let cursor = pos + 1;
    let escapedLineBreak = false;
    while (cursor < to) {
      const c = source.charAt(cursor);
      if (c === '"') break;
      if (c !== "\\") {
        cursor++;
        continue;
      }
      // `\\.` consumes one more code unit, but not a line terminator.
      if (cursor + 1 >= to || LINE_BREAK.test(source.charAt(cursor + 1))) {
        escapedLineBreak = true;
        break;
      }
      cursor += 2;
    }
    if (escapedLineBreak || cursor >= to) {
      noQuoteUntil = cursor;
      pos++;
      continue;
    }
    const name = params[index];
    if (name !== undefined) values.set(name, source.slice(pos + 1, cursor));
    index++;
    pos = cursor + 1;
  }
  return values;
}

function pushChunk(chunks: string[], path: string | undefined): void {
  if (path && path.endsWith(".js")) chunks.push(path);
}

/** Route path -> chunk paths, scanned once from left to right. */
function routeChunks(source: string, values: ReadonlyMap<string, string>): Map<string, string[]> {
  const routes = new Map<string, string[]>();
  let pos = 0;
  while (pos < source.length) {
    const key = source.indexOf('"', pos);
    if (key < 0) break;
    if (source.charAt(key + 1) !== "/") {
      pos = key + 1;
      continue;
    }
    const keyEnd = source.indexOf('"', key + 2);
    if (keyEnd < 0) break;
    let cursor = skipSpace(source, keyEnd + 1);
    if (source.charAt(cursor) !== ":") {
      pos = keyEnd;
      continue;
    }
    cursor = skipSpace(source, cursor + 1);
    if (source.charAt(cursor) !== "[") {
      pos = keyEnd;
      continue;
    }
    const route = source.slice(key + 1, keyEnd);
    const chunks: string[] = [];
    let item = cursor + 1;
    let closed = false;
    while (item < source.length) {
      const ch = source.charAt(item);
      if (ch === "]") {
        closed = true;
        break;
      }
      if (ch === '"') {
        const stop = source.indexOf('"', item + 1);
        // An unterminated literal leaves no later quote to start a key with.
        if (stop < 0) break;
        pushChunk(chunks, source.slice(item + 1, stop));
        item = stop + 1;
        continue;
      }
      if (ch === "," || SPACE.test(ch)) {
        item++;
        continue;
      }
      let stop = item + 1;
      while (stop < source.length) {
        const c = source.charAt(stop);
        if (c === "," || c === "]" || c === '"' || SPACE.test(c)) break;
        stop++;
      }
      pushChunk(chunks, values.get(source.slice(item, stop)));
      item = stop;
    }
    // Without a closing bracket no later array can close either, so the scan is over.
    if (!closed) break;
    if (chunks.length) routes.set(route, chunks);
    pos = item + 1;
  }
  return routes;
}

export function parseBuildManifest(source: string): Map<string, string[]> | null {
  const params = functionParams(source);
  if (!params && !hasObjectForm(source)) return null;
  const values = params ? tailValues(source, params) : new Map<string, string>();
  const routes = routeChunks(source, values);
  return routes.size ? routes : null;
}

function routeMentionCounts(sources: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const src of sources) {
    for (const m of src.matchAll(/(["'`])(\/[^"'`?#$\s]*)(?=\1|[?#$])/g)) {
      const route = m[2];
      if (route) counts.set(route, (counts.get(route) ?? 0) + 1);
    }
  }
  return counts;
}

function encodeURIPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function withoutQuery(url: URL): string {
  return url.origin + url.pathname;
}

export function nextRouteChunkUrls(
  descriptors: readonly ParentScriptDescriptor[],
  pageUrl: string,
): string[] {
  const manifest = descriptors.find(
    (d) =>
      d.src && MANIFEST_RE.test(d.resolvedSrc ?? d.src) && typeof d.prefetchedSource === "string",
  );
  const manifestSrc = manifest?.resolvedSrc ?? manifest?.src;
  if (!manifestSrc || typeof manifest?.prefetchedSource !== "string") return [];
  const routes = parseBuildManifest(manifest.prefetchedSource);
  if (!routes) return [];
  let base: URL;
  let query: string;
  try {
    const manifestUrl = new URL(manifestSrc, pageUrl);
    base = new URL(
      manifestUrl.pathname.replace(/static\/[^/]+\/_buildManifest\.js$/, ""),
      manifestUrl,
    );
    query = manifestUrl.search;
  } catch {
    return [];
  }
  const loaded = new Set<string>();
  const sources: string[] = [];
  for (const d of descriptors) {
    if (!d.src) continue;
    try {
      loaded.add(withoutQuery(new URL(d.resolvedSrc ?? d.src, pageUrl)));
    } catch {}
    if (
      typeof d.prefetchedSource === "string" &&
      (d.resolvedSrc ?? d.src).includes("/_next/static/chunks/")
    )
      sources.push(d.prefetchedSource);
  }
  const mentions = routeMentionCounts(sources);
  const ranked = [...routes.keys()]
    .filter((r) => !SKIP_ROUTES.has(r))
    .map((r) => ({ r, n: mentions.get(r) ?? 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  const out: string[] = [];
  for (const { r } of ranked) {
    for (const path of routes.get(r) ?? []) {
      const url = new URL(encodeURIPath(path) + query, base);
      const href = url.href;
      if (loaded.has(withoutQuery(url)) || out.includes(href)) continue;
      if (out.length >= MAX_ROUTE_CHUNKS) return out;
      out.push(href);
    }
  }
  return out;
}
