// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { escapeHtmlText, jsonForScript, MIB } from "../util.ts";

export const cors = new Hono();

const SECRET = "kitesurf-cross-origin-secret";

const anyOrigin = createMiddleware(async (c, next) => {
  await next();
  c.res.headers.set("access-control-allow-origin", "*");
});

const echoOrigin = createMiddleware(async (c, next) => {
  await next();
  const origin = c.req.header("origin");
  if (origin) c.res.headers.set("access-control-allow-origin", origin);
});

cors.use("/cors-sheet-acao.css", anyOrigin);
cors.use("/cors-sheet-echo-origin.css", echoOrigin);
cors.use("/tracked.css", anyOrigin);
cors.use("/module-registry-lib.js", echoOrigin);

cors.all("/cors-sheet-redirect.css", (c) =>
  c.redirect("https://ks-alt.invalid/__fixtures/cors-sheet-bare.css", 302),
);

cors.all("/cors-redirect", (c) =>
  c.body(null, 302, {
    location: c.req.query("to") ?? "/__fixtures/echo-headers.json",
    "access-control-allow-origin": c.req.header("origin") ?? "*",
    "access-control-allow-credentials": "true",
  }),
);

cors.all("/loud-redirect", (c) =>
  c.body(`${SECRET}-in-a-302-body`, 302, {
    location: c.req.query("to") ?? "/__fixtures/no-acao-secret.json",
    "x-secret-hop-header": SECRET,
    "set-cookie": `hopsession=${SECRET}; Path=/`,
    "content-type": "text/plain; charset=utf-8",
  }),
);

cors.all("/set-cookie", (c) =>
  c.body("ok", 200, {
    "content-type": "text/plain; charset=utf-8",
    "set-cookie": c.req.query("v") ?? "probe=1",
    "access-control-allow-origin": c.req.header("origin") ?? "*",
    "access-control-allow-credentials": "true",
  }),
);

const requestHeaders = (request: Request): Record<string, string> =>
  Object.fromEntries([...request.headers].map(([k, v]) => [k.toLowerCase(), v]));

cors.all("/echo-headers.json", (c) => {
  const origin = c.req.header("origin");
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": origin ?? "*",
  };
  if (origin) headers["access-control-allow-credentials"] = "true";
  return c.body(JSON.stringify(requestHeaders(c.req.raw)), 200, headers);
});

// echo-headers-frame.html: the same header map as a document, for
// frames. Scriptless, so the frame stays an in-process contentDocument
// (echo-headers.html below is the scripted variant).
cors.all("/echo-headers-frame.html", (c) =>
  c.html(
    `<!doctype html><html><body><pre id="h">${escapeHtmlText(JSON.stringify(requestHeaders(c.req.raw)))}</pre></body></html>`,
  ),
);

// echo-headers.html: HTML page that captures the incoming request
// headers as __ks_doc_headers + fetches echo-headers.json. Two contexts,
// two escapes: the <pre> is HTML text, the <script> is a JS string.
cors.all("/echo-headers.html", (c) => {
  const docHeaders = requestHeaders(c.req.raw);
  return c.html(`<!doctype html>
<html>
<head><meta charset="utf-8" /><title>echo-headers fixture</title></head>
<body>
<pre id="doc-headers">${escapeHtmlText(JSON.stringify(docHeaders))}</pre>
<script>
globalThis.__ks_doc_headers = ${jsonForScript(docHeaders)};
globalThis.__ks_fetch_headers = null;
globalThis.__ks_fetch_ready = (async () => {
  try {
    const res = await fetch("/__fixtures/echo-headers.json");
    globalThis.__ks_fetch_headers = await res.json();
  } catch (err) {
    globalThis.__ks_fetch_headers = { error: String(err) };
  }
})();
</script>
</body>
</html>`);
});

cors.all("/no-acao-secret.json", (c) => {
  const body = JSON.stringify({
    secret: SECRET,
    cookie: c.req.header("cookie") ?? "",
    origin: c.req.header("origin") ?? "",
    headers: [...c.req.raw.headers.keys()].sort().join(","),
  });
  const status = Number(c.req.query("status") ?? "200");
  const headers: Record<string, string> = {
    "content-type": "application/json; charset=utf-8",
  };
  if (c.req.query("chunked") === "1") return chunkedResponse(body, status, headers);
  applyContentLength(headers, c.req.query("lie"));
  return new Response(body, { status, headers });
});

function applyContentLength(headers: Record<string, string>, lie: string | undefined): void {
  if (lie) headers["content-length"] = lie;
}

function chunkedResponse(body: string, status: number, headers: Record<string, string>): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status, headers });
}

const BIG_SECRET_BYTES = 9 * MIB;
cors.all("/no-acao-big-secret.bin", (c) =>
  c.body(SECRET.repeat(Math.ceil(BIG_SECRET_BYTES / SECRET.length)), 200, {
    "content-type": "application/octet-stream",
  }),
);
