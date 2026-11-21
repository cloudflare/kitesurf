// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { registerCookieJar, unregisterCookieJar } from "../src/cdp/cookie-jar-registry.ts";
import { createCookieJar } from "../src/cookies.ts";
import {
  createSandboxOutboundOverride,
  type SandboxOutboundOverride,
} from "../src/eval/outbound.ts";
import {
  scanPreloadScriptLinks,
  scanStylesheetLinks,
  startStylesheetPrefetch,
} from "../src/eval/prefetch-stylesheets.ts";
import { inFlightReadBytes } from "../src/read-capped.ts";

function stubOutbound(
  responses: Record<string, { status: number; body: string; headers?: Record<string, string> }>,
): { override: SandboxOutboundOverride; calls: string[] } {
  const calls: string[] = [];
  const fetcher: Fetcher = {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const req = input instanceof Request ? input : new Request(input);
      calls.push(req.url);
      const entry = responses[req.url];
      if (!entry) return new Response("missing", { status: 404 });
      return new Response(entry.body, {
        status: entry.status,
        headers: { "content-type": "text/css", ...(entry.headers ?? {}) },
      });
    },
  } as Fetcher;
  const override: SandboxOutboundOverride = {
    external: false,
    parent: () => fetcher,
    loaded: () => fetcher,
    session: () => ({ outbound: async () => new Response("", { status: 404 }), cancelBodies() {} }),
    final: () => Promise.resolve(new Response("", { status: 404 })),
  };
  return { override, calls };
}

describe("scanStylesheetLinks", () => {
  it("extracts render-blocking stylesheet links and skips comments, noscript, print, and disabled", () => {
    const html = `<!doctype html><head>
      <!-- <link rel="stylesheet" href="/commented.css"> -->
      <noscript><link rel="stylesheet" href="/noscript.css"></noscript>
      <template><link rel="stylesheet" href="/template.css"></template>
      <textarea><link rel="stylesheet" href="/textarea.css"></textarea>
      <title><link rel="stylesheet" href="/title.css"></title>
      <iframe><link rel="stylesheet" href="/iframe-fallback.css"></iframe>
      <template><template></template><link rel="stylesheet" href="/nested-template.css"></template>
      <div data-html='<link rel="stylesheet" href="/attr.css">'></div>
      <script>const s = '<link rel="stylesheet" href="/in-script.css">';</script>
      <link rel="stylesheet" href="/a.css?x=1&amp;y=2">
      <link rel="stylesheet" href="/b.css" crossorigin>
      <link rel="stylesheet" href="/c.css" crossorigin="use-credentials" media="screen">
      <link rel="stylesheet" href="/print.css" media="print">
      <link rel="alternate stylesheet" href="/alt.css">
      <link rel="stylesheet" href="/disabled.css" disabled>
      <link rel="stylesheet" href="/a.css?x=1&amp;y=2">
    </head>`;
    expect(scanStylesheetLinks(html, "https://example.com/dir/page")).toEqual([
      { url: "https://example.com/a.css?x=1&y=2", corsMode: "no-cors" },
      { url: "https://example.com/b.css", corsMode: "cors" },
      { url: "https://example.com/c.css", corsMode: "cors" },
    ]);
  });

  it("decodes character references once, so an escaped ampersand stays escaped", () => {
    const html = `<link rel="stylesheet" href="/d.css?a=1&#38;amp;b=2"><link rel="stylesheet" href="/e.css?a=1&#38;b=2">`;
    expect(scanStylesheetLinks(html, "https://example.com/dir/page")).toEqual([
      { url: "https://example.com/d.css?a=1&amp;b=2", corsMode: "no-cors" },
      { url: "https://example.com/e.css?a=1&b=2", corsMode: "no-cors" },
    ]);
  });
});

describe("scanPreloadScriptLinks", () => {
  it("extracts preload as=script links while skipping non-script preloads, comments, and textarea", () => {
    const html = `<!doctype html><head>
      <!-- <link rel="preload" as="script" href="/commented.js"> -->
      <textarea><link rel="preload" as="script" href="/in-textarea.js"></textarea>
      <iframe><link rel="preload" as="script" href="/in-iframe.js"></iframe>
      <template><template></template><link rel="preload" as="script" href="/in-nested-template.js"></template>
      <div data-x='<link rel="preload" as="script" href="/in-attr.js">'></div>
      <link rel="preload" as="style" href="/style.css">
      <link rel="preload" as="script" href="/chunk-a.js">
      <link rel="preload" as="script" href="/chunk-a.js">
      <link rel="preload" as="SCRIPT" href="https://cdn.example.com/chunk-b.js?v=1&amp;x=2">
    </head>`;
    expect(scanPreloadScriptLinks(html, "https://example.com/app/")).toEqual([
      "https://example.com/chunk-a.js",
      "https://cdn.example.com/chunk-b.js?v=1&x=2",
    ]);
  });
});

describe("startStylesheetPrefetch", () => {
  it("serves prefetched 200 stylesheets once for matching cors mode and skips CSP-restricted docs", async () => {
    const { override, calls } = stubOutbound({
      "https://example.com/a.css": {
        status: 200,
        body: "body { color: red; }",
        headers: { "x-kitesurf-cors": "clean" },
      },
      "https://example.com/redir.css": {
        status: 302,
        body: "",
        headers: { location: "https://example.com/a.css" },
      },
    });
    const html = `<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/redir.css">`;

    // CSP restricting style-src disables speculative prefetch.
    const blocked = startStylesheetPrefetch({
      html,
      baseUrl: "https://example.com/",
      pageUrl: "https://example.com/",
      pageOrigin: "https://example.com",
      connectionId: "",
      mainFrameId: "f1",
      mainLoaderId: "l1",
      extraHeaders: {},
      cookieKey: "",
      cspHeaders: ["style-src 'self'"],
      sandboxOutbound: override,
    });
    expect(blocked).toBeNull();
    expect(calls).toEqual([]);

    const prefetched = startStylesheetPrefetch({
      html,
      baseUrl: "https://example.com/",
      pageUrl: "https://example.com/",
      pageOrigin: "https://example.com",
      connectionId: "",
      mainFrameId: "f1",
      mainLoaderId: "l1",
      extraHeaders: {},
      cookieKey: "",
      cspHeaders: [],
      sandboxOutbound: override,
    });
    expect(prefetched).not.toBeNull();

    const makeReq = (url: string, corsMode = "no-cors", credentials = "same-origin") => ({
      url,
      method: "GET",
      headers: [
        ["x-kitesurf-resource-type", "Stylesheet"],
        ["x-kitesurf-initiator", "parser"],
        ["x-kitesurf-stylesheet-cors", corsMode],
        ["x-kitesurf-credentials", credentials],
      ] as Array<[string, string]>,
      body: null,
    });

    // Wrong corsMode or credentials mode misses cleanly without consuming the real entry.
    expect(prefetched!.take(makeReq("https://example.com/a.css", "cors"))).toBeNull();
    expect(prefetched!.take(makeReq("https://example.com/a.css", "no-cors", "include"))).toBeNull();

    const hit = await prefetched!.take(makeReq("https://example.com/a.css"));
    expect(hit).not.toBeNull();
    expect(await hit!.text()).toBe("body { color: red; }");
    expect(hit!.headers.get("x-kitesurf-cors")).toBe("clean");

    // One-shot: second request misses.
    expect(prefetched!.take(makeReq("https://example.com/a.css"))).toBeNull();

    // Redirects resolve to null so PageScript follows them normally.
    const redir = await prefetched!.take(makeReq("https://example.com/redir.css"));
    expect(redir).toBeNull();

    prefetched!.cancel();
  });

  it("does not send jar cookies on anonymous cross-origin stylesheet prefetch", async () => {
    const connId = "stylesheet-cookie-regression";
    const jar = createCookieJar();
    jar.setFromHeader("https://sheet.test/", "sid=dummy; Secure; SameSite=None; Path=/");
    registerCookieJar(connId, jar);
    const seen: Array<string | null> = [];
    const sandboxOutbound = createSandboxOutboundOverride(
      {
        SandboxOutbound() {
          throw new Error("Unexpected loaded-worker fetch");
        },
      },
      { FONT_ASSETS: { fetch: async () => new Response(null, { status: 404 }) } },
      {
        fetch: async (req) => {
          seen.push(req.headers.get("cookie"));
          return new Response("a {}", {
            headers: {
              "content-type": "text/css",
              "access-control-allow-origin": "*",
            },
          });
        },
      },
    );
    const job = startStylesheetPrefetch({
      html: '<link rel="stylesheet" crossorigin href="https://sheet.test/a.css">',
      baseUrl: "https://page.test/",
      pageUrl: "https://page.test/",
      pageOrigin: "https://page.test",
      connectionId: connId,
      cookieKey: connId,
      mainFrameId: "f1",
      mainLoaderId: "l1",
      extraHeaders: {},
      cspHeaders: [],
      sandboxOutbound,
    });
    try {
      const hit = await job?.take({
        url: "https://sheet.test/a.css",
        method: "GET",
        headers: [
          ["x-kitesurf-resource-type", "Stylesheet"],
          ["x-kitesurf-initiator", "parser"],
          ["x-kitesurf-stylesheet-cors", "cors"],
          ["x-kitesurf-credentials", "same-origin"],
        ],
        body: null,
      });
      expect(hit).not.toBeNull();
      expect(seen).toEqual([null]);
    } finally {
      job?.cancel();
      unregisterCookieJar(connId);
    }
  });

  it("charges parked stylesheet body chunks against the shared read budget before EOF", async () => {
    const initial = inFlightReadBytes();
    let finish = () => {};
    let markBuffered = () => {};
    const buffered = new Promise<void>((resolve) => {
      markBuffered = resolve;
    });
    let first = true;
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          finish = () => controller.close();
        },
        pull(controller) {
          if (first) {
            first = false;
            controller.enqueue(new Uint8Array(1024));
          } else {
            markBuffered();
          }
        },
      },
      { highWaterMark: 0 },
    );
    const sandboxOutbound = createSandboxOutboundOverride(
      {
        SandboxOutbound() {
          throw new Error("Unexpected loaded-worker fetch");
        },
      },
      { FONT_ASSETS: { fetch: async () => new Response(null, { status: 404 }) } },
      {
        fetch: async () => new Response(body, { headers: { "content-type": "text/css" } }),
      },
    );
    const job = startStylesheetPrefetch({
      html: '<link rel="stylesheet" href="https://sheet.test/slow.css">',
      baseUrl: "https://page.test/",
      pageUrl: "https://page.test/",
      pageOrigin: "https://page.test",
      connectionId: "stylesheet-budget-regression",
      cookieKey: "stylesheet-budget-regression",
      mainFrameId: "f1",
      mainLoaderId: "l1",
      extraHeaders: {},
      cspHeaders: [],
      sandboxOutbound,
    });
    try {
      await buffered;
      expect(inFlightReadBytes() - initial).toBe(1024);
    } finally {
      finish();
      job?.cancel();
    }
  });
});
