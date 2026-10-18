// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Extracts likely route chunk URLs from Next.js manifests and page script text.

import type { ParentScriptDescriptor } from "../wasm.ts";

const MANIFEST_RE = /\/_next\/static\/[^/]+\/_buildManifest\.js(?:\?.*)?$/;
const MAX_ROUTE_CHUNKS = 12;
const SKIP_ROUTES = new Set(["/_app", "/_error", "/404", "/500"]);

export function parseBuildManifest(source: string): Map<string, string[]> | null {
  const fn = /__BUILD_MANIFEST\s*=\s*function\(([^)]*)\)\s*\{\s*return\s*\{/.exec(source);
  const params = (fn?.[1] ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const values = new Map<string, string>();
  if (fn) {
    const tail = /\}\s*\}\s*\(([\s\S]*)\)\s*[;,]?\s*(?:self\.__BUILD_MANIFEST_CB|$)/.exec(source);
    const args = [...(tail?.[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"|[^,"]+/g)].map(
      (m) => m[1] ?? null,
    );
    params.forEach((p, i) => {
      const v = args[i];
      if (typeof v === "string") values.set(p, v);
    });
  } else if (!/__BUILD_MANIFEST\s*=\s*\{/.test(source)) {
    return null;
  }
  const routes = new Map<string, string[]>();
  for (const m of source.matchAll(/"(\/[^"]*)"\s*:\s*\[((?:"[^"]*"|[^\]"])*)\]/g)) {
    const chunks: string[] = [];
    const route = m[1];
    if (!route) continue;
    for (const item of (m[2] ?? "").matchAll(/"([^"]*)"|[^,\s"]+/g)) {
      const path = item[1] ?? values.get(item[0]);
      if (path && /\.js$/.test(path)) chunks.push(path);
    }
    if (chunks.length) routes.set(route, chunks);
  }
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
