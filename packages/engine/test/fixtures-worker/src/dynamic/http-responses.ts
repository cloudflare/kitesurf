// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import responsePageHtml from "../../assets/http-response-page.html";

const LAST_MODIFIED = "Wed, 01 Jan 2025 00:00:00 GMT";

export const httpResponses = new Hono();

httpResponses.all("/response-shapes/page.html", (c) =>
  c.html(responsePageHtml, 200, {
    "cache-control": "public, max-age=60",
    etag: '"response-shapes"',
    "last-modified": LAST_MODIFIED,
    "set-cookie": "secret=do-not-return",
    "www-authenticate": "Basic realm=private",
    "x-kitesurf-fixture": "internal",
  }),
);

httpResponses.all("/response-shapes/redirect", (c) =>
  c.redirect("/__fixtures/response-shapes/page.html", 302),
);

httpResponses.all("/response-shapes/conditional", (c) => {
  const validators = {
    etag: '"response-conditional"',
    "last-modified": LAST_MODIFIED,
    "cache-control": "public, max-age=60",
  };
  if (c.req.header("if-modified-since") === LAST_MODIFIED) {
    return c.body(null, 304, validators);
  }
  return c.html(responsePageHtml, 200, validators);
});

httpResponses.all("/response-shapes/status", (c) =>
  c.html(responsePageHtml, 404, { "cache-control": "no-store" }),
);

httpResponses.all("/response-shapes/no-content", (c) =>
  c.body(null, 204, { "x-fixture-status": "empty" }),
);
