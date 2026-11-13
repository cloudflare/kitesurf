// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The standalone engine's root page. Embedders answer `/` through EngineHost.serveFallback,
// so their wrapped runs exclude this file rather than the rest of the routes suite.

import { env } from "cloudflare:test";
import { expect, test } from "./harness";

function engine(path: string, init?: RequestInit): Promise<Response> {
  return env.ENGINE.fetch(`https://ks.invalid${path}`, {
    redirect: "manual",
    ...init,
  });
}

function exampleHref(frontend: string, scheme: "ws" | "wss", host: string): string {
  const endpoint =
    `${host}/devtools/page/kitesurf?initialUrl=` +
    encodeURIComponent("https://en.wikipedia.org/wiki/Kitesurfing");
  const href = `${frontend}?${scheme}=${encodeURIComponent(endpoint)}`;
  return `href="${href.replaceAll("&", "&amp;")}"`;
}

test("/ without inspector params, or with a non-http(s) url, serves the landing page", async () => {
  for (const path of ["/", "/?url=" + encodeURIComponent("ftp://example.com/"), "/?url=nope"]) {
    const res = await engine(path);
    expect(res.status, path).toBe(200);
    expect(res.headers.get("location"), path).toBeNull();
    expect(res.headers.get("content-type"), path).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("content-security-policy");
    expect(csp, path).toContain("default-src 'none'");
    expect(csp, path).toContain("form-action 'self'");
    const html = await res.text();
    expect(html, path).toContain('<form class="omnibox" action="/" method="get"');
    expect(html, path).toContain('id="inspect-form"');
    // The picker sits in the header and joins the URL form through its form attribute.
    expect(html, path).toContain('<select name="ks_font_profile" form="inspect-form">');
    expect(html, path).toContain('<option value="">Default</option>');
    expect(html, path).toContain('<option value="macos">Chrome on macOS</option>');
    expect(html, path).toContain(exampleHref("https://example.com/devtools", "wss", "ks.invalid"));
    expect(html, path).toContain("DevTools loads from <code>example.com</code>");
    expect(html, path).toContain("wss://ks.invalid/devtools/browser");
    expect(html, path).toContain("wss://ks.invalid/devtools/page/kitesurf");
    expect(html, path).toContain('<a href="/json/version">');
    // chrome://inspect cannot discover an HTTPS engine.
    expect(html, path).not.toContain("chrome://inspect/#devices");
  }
});

test("over HTTP, the landing page adds the chrome://inspect steps for this host:port", async () => {
  const res = await env.ENGINE.fetch("http://127.0.0.1:8787/");
  const html = await res.text();
  expect(html).toContain("chrome://inspect/#devices");
  expect(html).toContain("<code>127.0.0.1:8787</code>");
  expect(html).toContain("ws://127.0.0.1:8787/devtools/browser");
});

test("opened as localhost, the hosted examples connect to 127.0.0.1", async () => {
  const html = await (await env.ENGINE.fetch("http://localhost:8787/")).text();
  expect(html).toContain(exampleHref("https://example.com/devtools", "ws", "127.0.0.1:8787"));
});

test("with a same-origin frontend, / serves the landing page with same-origin examples", async () => {
  const res = await env.ENGINE_SAME_ORIGIN_INSPECTOR.fetch("https://ks.invalid/", {
    redirect: "manual",
  });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain('<form class="omnibox" action="/" method="get"');
  expect(html).toContain(
    exampleHref("https://ks.invalid/inspector/inspector.html", "wss", "ks.invalid"),
  );
  expect(html).not.toContain("DevTools loads from");
});

test("without a frontend, / leaves only the CDP endpoints", async () => {
  const res = await env.ENGINE_NO_INSPECTOR.fetch("https://ks.invalid/", { redirect: "manual" });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).not.toContain("<form");
  expect(html).not.toContain("ks_font_profile");
  expect(html).toContain("serves no DevTools frontend");
  expect(html).toContain("wss://ks.invalid/devtools/browser");
  expect(html).toContain("wss://ks.invalid/devtools/page/kitesurf");
  expect(html).toContain("browserWSEndpoint");
});
