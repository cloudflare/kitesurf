// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";

import { documentKind, imageDocumentHtml } from "../src/cdp/document-kind.ts";

function kind(contentType: string | null, disposition?: string): string {
  const h = new Headers();
  if (contentType !== null) h.set("content-type", contentType);
  if (disposition !== undefined) h.set("content-disposition", disposition);
  return documentKind(h);
}

describe("documentKind", () => {
  it.each([
    ["text/html; charset=utf-8", "html"],
    ["TEXT/HTML", "html"],
    ["application/xhtml+xml", "html"],
    ["application/json", "json"],
    ["application/ld+json", "json"],
    ["image/svg+xml", "svg"],
    ["image/png", "image"],
    ["image/jpeg", "image"],
    ["image/gif", "image"],
    ["image/webp", "image"],
    ["text/plain; charset=utf-8", "text"],
    ["text/css", "text"],
    ["text/xml", "text"],
    ["application/javascript", "text"],
    ["application/xml", "text"],
    ["application/rss+xml", "text"],
    ["application/atom+xml", "text"],
    ["application/pdf", "blocked"],
    ["application/octet-stream", "blocked"],
    ["application/zip", "blocked"],
    ["video/mp4", "blocked"],
    ["audio/mpeg", "blocked"],
    ["font/woff2", "blocked"],
    ["image/avif", "blocked"],
    ["image/bmp", "blocked"],
    ["image/x-icon", "blocked"],
  ])("%s → %s", (ct, expected) => {
    expect(kind(ct)).toBe(expected);
  });

  it("keeps the HTML default when the type is missing or empty", () => {
    expect(kind(null)).toBe("html");
    expect(kind("")).toBe("html");
  });

  it("blocks attachments even when the type renders", () => {
    expect(kind("text/html", "attachment; filename=a.html")).toBe("blocked");
    expect(kind("image/png", "ATTACHMENT")).toBe("blocked");
    expect(kind("text/html", "form-data")).toBe("blocked");
  });

  it("renders inline and typeless dispositions", () => {
    expect(kind("text/html", "inline")).toBe("html");
    expect(kind("text/html", "inline; filename=a.html")).toBe("html");
    expect(kind("text/html", "filename=a.html")).toBe("html");
    expect(kind("text/html", "")).toBe("html");
  });
});

describe("imageDocumentHtml", () => {
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2,
    0, 0, 0, 3, 8, 6, 0, 0, 0,
  ]);

  it("embeds the bytes and titles the document like Chrome", () => {
    const html = imageDocumentHtml(
      png,
      "QUJD",
      "image/png; foo=bar",
      "https://ex.com/a/cat%20pic.png?x=1",
    );
    expect(html).toContain('<img src="data:image/png;base64,QUJD">');
    expect(html).toContain("<title>cat pic.png (2\u00d73)</title>");
  });

  it("falls back to the host, then to the size alone", () => {
    expect(imageDocumentHtml(png, "", "image/png", "https://ex.com/")).toContain(
      "<title>ex.com (2\u00d73)</title>",
    );
    expect(imageDocumentHtml(png, "", "image/png", "data:image/png;base64,")).toContain(
      "<title>2\u00d73</title>",
    );
  });

  it("escapes the title", () => {
    const html = imageDocumentHtml(png, "", "image/png", "https://ex.com/%3Cb%3E.png");
    expect(html).toContain("<title>&lt;b&gt;.png (2\u00d73)</title>");
  });
});
