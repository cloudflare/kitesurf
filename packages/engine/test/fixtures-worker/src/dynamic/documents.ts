// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { Hono } from "hono";
import cookiesHtml from "../../assets/cookies.html";
import euckrChildHtml from "../../assets/euckr-child.html.bin";
import euckrFormHtml from "../../assets/euckr-form.html";
import latin1Css from "../../assets/latin1.css.bin";
import svgDocumentMetadata from "../../assets/svg-document-metadata.svg";
import svgDocumentOverflowing from "../../assets/svg-document-overflowing.svg";
import svgDocumentPrologue from "../../assets/svg-document-prologue.svg";
import svgDocumentSized from "../../assets/svg-document-sized.svg";
import svgDocumentStyled from "../../assets/svg-document-styled.svg";
import svgDocumentViewbox from "../../assets/svg-document-viewbox.svg";
import { escapeHtmlText, KIB } from "../util.ts";

export const documents = new Hono();

documents.all("/status-204", (c) => c.body(null, 204));

documents.all("/attachment.html", (c) =>
  c.html("<!doctype html><p>download me</p>", 200, {
    "content-disposition": 'attachment; filename="attachment.html"',
  }),
);

const REDIRECT_HOPS = 3;
documents.all("/redirect-hop", (c) => {
  const hop = parseInt(c.req.query("n") ?? "1", 10);
  return c.redirect(
    hop >= REDIRECT_HOPS ? "/__fixtures/lifecycle.html" : `/__fixtures/redirect-hop?n=${hop + 1}`,
    302,
  );
});

documents.all("/cookies.html", (c) => {
  c.header("set-cookie", "server_cookie=hello; Path=/; Max-Age=3600", { append: true });
  c.header("set-cookie", "session_only=keep; Path=/", { append: true });
  return c.html(cookiesHtml);
});

documents.all("/term-selection-navigation", (c) => {
  if (c.req.header("cookie")?.includes("term-visited=1")) {
    return c.html("<!doctype html><div>zero one two three four</div>");
  }
  return c.html(
    `<!doctype html><a href="/__fixtures/term-selection-navigation">next</a>
<script>for (let i = 0; i < 100; i++) document.body.dataset.n = i;</script>`,
    200,
    { "set-cookie": "term-visited=1; Path=/; SameSite=Lax" },
  );
});

documents.all("/gzip-only-doc.html", (c) => {
  const acceptEncoding = c.req.header("accept-encoding") ?? "";
  const html = `<!doctype html><title>gzip-only</title>
<div id="ae">${escapeHtmlText(acceptEncoding)}</div>
<div id="tail">${"x".repeat(4 * KIB)}complete</div>`;
  const bytes = new TextEncoder().encode(html);
  if (!/\bgzip\b/i.test(acceptEncoding)) {
    const truncated = new ReadableStream<Uint8Array>({
      start(ctl) {
        ctl.enqueue(bytes.subarray(0, 1 * KIB));
      },
      pull(ctl) {
        ctl.error(new Error("gzip-only-doc: connection dropped"));
      },
    });
    return new Response(truncated, { headers: { "content-type": "text/html" } });
  }
  const gzipped = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(gzipped, {
    headers: { "content-type": "text/html", "content-encoding": "gzip" },
    encodeBody: "manual",
  });
});

documents.all("/form-echo", async (c) => {
  let body = "";
  try {
    body = await c.req.text();
  } catch {}
  return c.html(`<!doctype html><html><body>
  <div id="method">${escapeHtmlText(c.req.method)}</div>
  <div id="ctype">${escapeHtmlText(c.req.header("content-type") || "")}</div>
  <div id="body">${escapeHtmlText(body)}</div>
  <div id="query">${escapeHtmlText(new URL(c.req.url).search)}</div>
</body></html>`);
});

documents.all("/oversize-doc.html", (c) => {
  const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
  const declared = c.req.query("declared");
  if (declared) headers["content-length"] = declared;
  if (c.req.query("endless") === "1") {
    const chunk = new TextEncoder().encode("<p>".padEnd(64 * KIB, "x"));
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    return c.body(endless, 200, headers);
  }
  return c.body("<html><body>small</body></html>", 200, headers);
});

const SVG_DOCUMENTS: Record<string, string> = {
  sized: svgDocumentSized,
  prologue: svgDocumentPrologue,
  viewbox: svgDocumentViewbox,
  metadata: svgDocumentMetadata,
  overflowing: svgDocumentOverflowing,
  styled: svgDocumentStyled,
};
documents.all("/svg-document.svg", (c) =>
  c.body(SVG_DOCUMENTS[c.req.query("case") ?? ""] ?? svgDocumentSized, 200, {
    "content-type": "image/svg+xml; charset=utf-8",
  }),
);

documents.all("/latin1.css", (c) =>
  c.body(latin1Css, 200, { "content-type": "text/css; charset=iso-8859-15" }),
);
documents.all("/euckr-child.html", (c) =>
  c.body(euckrChildHtml, 200, { "content-type": "text/html; charset=euc-kr" }),
);
documents.all("/euckr-form.html", (c) =>
  c.body(euckrFormHtml, 200, { "content-type": "text/html; charset=euc-kr" }),
);
