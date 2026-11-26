// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The Docker image's front Worker (scripts/workerd-config.mjs). It routes requests to public/ or
// the engine as Wrangler's assets config does, and serves public/ to the engine as FONT_ASSETS.

import { WorkerEntrypoint } from "cloudflare:workers";

// Wrangler's `run_worker_first` routes, which scripts/workerd-config.mjs checks.
const workerFirst = (pathname) => pathname === "/" || pathname.startsWith("/rbi/");

// workerd's disk service sends every file as application/octet-stream.
const CONTENT_TYPES = {
  avif: "image/avif",
  css: "text/css; charset=utf-8",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  mjs: "text/javascript; charset=utf-8",
  otf: "font/otf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  webp: "image/webp",
  woff2: "font/woff2",
};

/** Applies public/_headers, which scripts/workerd-config.mjs compiles into the HEADERS binding.
 * As on Cloudflare, every matching rule applies, and a header that several set joins with ", ".
 * @param {{pattern: string, set: [string, string][], unset: string[]}[]} rules */
const applyHeaderRules = function (rules, pathname, headers) {
  const fromRules = new Set();
  for (const rule of rules) {
    if (!new RegExp(rule.pattern).test(pathname)) continue;
    for (const [name, value] of rule.set) {
      if (fromRules.has(name)) headers.append(name, value);
      else headers.set(name, value);
      fromRules.add(name);
    }
    for (const name of rule.unset) headers.delete(name);
  }
};

/** A file from public/, or 404. Only names with an extension are files: the disk service answers
 * a directory with its listing. */
const serveFile = async function (env, request) {
  // workerd's disk service answers 404 for a path with an empty segment.
  const pathname = new URL(request.url).pathname.replace(/\/{2,}/g, "/");
  const extension = /\.([a-z0-9]+)$/i.exec(pathname)?.[1].toLowerCase();
  if (extension === undefined || (request.method !== "GET" && request.method !== "HEAD")) {
    return new Response("not found", { status: 404 });
  }
  // Concatenated, not resolved against a base: `//x.txt` would make `x.txt` the host.
  const file = await env.PUBLIC.fetch(new URL("http://public" + pathname), {
    method: request.method,
  });
  if (!file.ok) {
    await file.body?.cancel();
    return new Response("not found", { status: 404 });
  }
  const headers = new Headers(file.headers);
  headers.set("content-type", CONTENT_TYPES[extension] ?? "application/octet-stream");
  applyHeaderRules(env.HEADERS ?? [], pathname, headers);
  // workerd's disk service sends last-modified and no ETag, and ignores if-modified-since.
  const lastModified = Date.parse(file.headers.get("last-modified") ?? "");
  const since = Date.parse(request.headers.get("if-modified-since") ?? "");
  if (lastModified <= since) {
    await file.body?.cancel();
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  return new Response(file.body, { status: 200, headers });
};

export class Assets extends WorkerEntrypoint {
  /** @param {Request} request @returns {Promise<Response>} */
  fetch(request) {
    return serveFile(this.env, request);
  }
}

let announced = false;

export default {
  /** @param {Request} request @param {{ENGINE: Fetcher, PUBLIC: Fetcher, HEADERS: unknown[]}} env
   * @returns {Promise<Response>} */
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (!workerFirst(pathname) && !request.headers.has("upgrade")) {
      const file = await serveFile(env, request);
      if (file.status !== 404) return file;
    }
    const response = await env.ENGINE.fetch(request);
    // Logged once the engine first answers, normally Docker's health check about a second after
    // start. A request that the engine fails leaves the next one to try again.
    if (!announced && response.status < 500) {
      announced = true;
      console.log("[kitesurf] ready: CDP at /devtools/browser, discovery at /json/version");
    }
    return response;
  },
};
