// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Extracts likely route chunk URLs from Next.js manifests and page script text.

import type { ParentScriptDescriptor } from "../wasm.ts";

const MANIFEST_RE = /\/_next\/static\/[^/]+\/_buildManifest\.js(?:\?.*)?$/;
const MAX_ROUTE_CHUNKS = 12;
const SKIP_ROUTES = new Set(["/_app", "/_error", "/404", "/500"]);

function functionParameterValues(source: string, paramsSource: string): Map<string, string> {
  const params = paramsSource
    .split(",")
    .map((parameter) => parameter.trim())
    .filter(Boolean);
  const tail = /\}\s*\}\s*\(([\s\S]*)\)\s*[;,]?\s*(?:self\.__BUILD_MANIFEST_CB|$)/.exec(source);
  const args = [...(tail?.[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"|[^,"]+/g)].map(
    (match) => match[1] ?? null,
  );
  const values = new Map<string, string>();
  for (const [index, parameter] of params.entries()) {
    const value = args[index];
    if (typeof value === "string") values.set(parameter, value);
  }
  return values;
}

function hasBuildManifestShape(fn: RegExpExecArray | null, source: string): boolean {
  return fn !== null || /__BUILD_MANIFEST\s*=\s*\{/.test(source);
}

function manifestRouteChunks(raw: string, values: Map<string, string>): string[] {
  const chunks: string[] = [];
  for (const item of raw.matchAll(/"([^"]*)"|[^,\s"]+/g)) {
    const path = item[1] ?? values.get(item[0]);
    if (path && /\.js$/.test(path)) chunks.push(path);
  }
  return chunks;
}

function parseManifestRoutes(source: string, values: Map<string, string>): Map<string, string[]> {
  const routes = new Map<string, string[]>();
  const routePattern = /"(\/[^\"]*)"\s*:\s*\[((?:"[^"]*"|[^\]"])*)\]/g;
  for (const match of source.matchAll(routePattern)) {
    const route = match[1];
    if (!route) continue;
    const chunks = manifestRouteChunks(match[2] ?? "", values);
    if (chunks.length) routes.set(route, chunks);
  }
  return routes;
}

export function parseBuildManifest(source: string): Map<string, string[]> | null {
  const fn = /__BUILD_MANIFEST\s*=\s*function\(([^)]*)\)\s*\{\s*return\s*\{/.exec(source);
  if (!hasBuildManifestShape(fn, source)) return null;
  const values = fn ? functionParameterValues(source, fn[1] ?? "") : new Map<string, string>();
  const routes = parseManifestRoutes(source, values);
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

interface ManifestBase {
  base: URL;
  query: string;
}

function manifestBase(manifestSrc: string, pageUrl: string): ManifestBase | null {
  try {
    const manifestUrl = new URL(manifestSrc, pageUrl);
    const base = new URL(
      manifestUrl.pathname.replace(/static\/[^/]+\/_buildManifest\.js$/, ""),
      manifestUrl,
    );
    return { base, query: manifestUrl.search };
  } catch {
    return null;
  }
}

function recordLoadedScript(
  loaded: Set<string>,
  descriptor: ParentScriptDescriptor,
  pageUrl: string,
): void {
  if (!descriptor.src) return;
  try {
    loaded.add(withoutQuery(new URL(descriptor.resolvedSrc ?? descriptor.src, pageUrl)));
  } catch {}
}

function recordChunkSource(sources: string[], descriptor: ParentScriptDescriptor): void {
  if (!descriptor.src) return;
  if (
    typeof descriptor.prefetchedSource === "string" &&
    (descriptor.resolvedSrc ?? descriptor.src).includes("/_next/static/chunks/")
  ) {
    sources.push(descriptor.prefetchedSource);
  }
}

function collectLoadedScripts(
  descriptors: readonly ParentScriptDescriptor[],
  pageUrl: string,
): { loaded: Set<string>; sources: string[] } {
  const loaded = new Set<string>();
  const sources: string[] = [];
  for (const descriptor of descriptors) {
    recordLoadedScript(loaded, descriptor, pageUrl);
    recordChunkSource(sources, descriptor);
  }
  return { loaded, sources };
}

function rankedRoutes(
  routes: Map<string, string[]>,
  mentions: Map<string, number>,
): Array<{ r: string; n: number }> {
  return [...routes.keys()]
    .filter((route) => !SKIP_ROUTES.has(route))
    .map((r) => ({ r, n: mentions.get(r) ?? 0 }))
    .filter((route) => route.n > 0)
    .sort((a, b) => b.n - a.n);
}

function appendRouteChunk(
  path: string,
  query: string,
  base: URL,
  loaded: Set<string>,
  out: string[],
): boolean {
  const url = new URL(encodeURIPath(path) + query, base);
  const href = url.href;
  if (loaded.has(withoutQuery(url)) || out.includes(href)) return true;
  if (out.length >= MAX_ROUTE_CHUNKS) return false;
  out.push(href);
  return true;
}

function routeChunkUrls(
  ranked: Array<{ r: string; n: number }>,
  routes: Map<string, string[]>,
  base: URL,
  query: string,
  loaded: Set<string>,
): string[] {
  const out: string[] = [];
  for (const { r } of ranked) {
    const paths = routes.get(r);
    if (!paths) continue;
    for (const path of paths) {
      if (!appendRouteChunk(path, query, base, loaded, out)) return out;
    }
  }
  return out;
}

interface ManifestInputs {
  src: string;
  source: string;
}

interface BuildManifestDescriptor extends ParentScriptDescriptor {
  src: string;
  prefetchedSource: string;
}

function isBuildManifestDescriptor(
  descriptor: ParentScriptDescriptor,
): descriptor is BuildManifestDescriptor {
  return Boolean(
    descriptor.src &&
    MANIFEST_RE.test(descriptor.resolvedSrc ?? descriptor.src) &&
    typeof descriptor.prefetchedSource === "string",
  );
}

function findManifestInputs(descriptors: readonly ParentScriptDescriptor[]): ManifestInputs | null {
  const manifest = descriptors.find(isBuildManifestDescriptor);
  if (!manifest) return null;
  return {
    src: manifest.resolvedSrc ?? manifest.src,
    source: manifest.prefetchedSource,
  };
}

export function nextRouteChunkUrls(
  descriptors: readonly ParentScriptDescriptor[],
  pageUrl: string,
): string[] {
  const manifest = findManifestInputs(descriptors);
  if (!manifest) return [];
  const routes = parseBuildManifest(manifest.source);
  if (!routes) return [];
  const location = manifestBase(manifest.src, pageUrl);
  if (!location) return [];
  const { loaded, sources } = collectLoadedScripts(descriptors, pageUrl);
  const ranked = rankedRoutes(routes, routeMentionCounts(sources));
  return routeChunkUrls(ranked, routes, location.base, location.query, loaded);
}
