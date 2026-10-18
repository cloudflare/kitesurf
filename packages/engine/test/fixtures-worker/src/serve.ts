// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { bench } from "./dynamic/bench.ts";
import { cors } from "./dynamic/cors.ts";
import { httpResponses } from "./dynamic/http-responses.ts";
import { documents } from "./dynamic/documents.ts";
import { fonts } from "./dynamic/fonts.ts";
import { frames } from "./dynamic/frames.ts";
import { scripts } from "./dynamic/scripts.ts";
import { slow } from "./dynamic/slow.ts";
import { wsEcho } from "./dynamic/ws-echo.ts";
import { snapshot } from "./snapshot.ts";
import { STATIC_FIXTURES } from "./static.ts";

const CONTENT_TYPES = new Map([
  ["html", "text/html; charset=utf-8"],
  ["js", "text/javascript; charset=utf-8"],
  ["mjs", "text/javascript; charset=utf-8"],
  ["css", "text/css; charset=utf-8"],
  ["json", "application/json"],
  ["svg", "image/svg+xml"],
  ["txt", "text/plain; charset=utf-8"],
  ["woff2", "font/woff2"],
  ["png", "image/png"],
  ["wasm", "application/wasm"],
]);

export const app = new Hono();

app.onError((err) => {
  throw err;
});
app.notFound((c) => c.text("not found", 404));

// cors registers middleware on static files, so it goes before them.
for (const family of [
  snapshot,
  httpResponses,
  fonts,
  slow,
  bench,
  frames,
  scripts,
  cors,
  documents,
  wsEcho,
]) {
  app.route("/__fixtures", family);
}

app.all("/__fixtures/*", (c) => {
  const key = c.req.path.slice("/__fixtures/".length);
  const body = Object.hasOwn(STATIC_FIXTURES, key) ? STATIC_FIXTURES[key] : undefined;
  const type = CONTENT_TYPES.get(key.slice(key.lastIndexOf(".") + 1));
  if (body === undefined || type === undefined) return c.notFound();
  return c.body(body, 200, { "content-type": type });
});
