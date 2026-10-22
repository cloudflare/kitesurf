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

test("/ without inspector params, or with a non-http(s) url, serves the chrome://inspect page", async () => {
  for (const path of ["/", "/?url=" + encodeURIComponent("ftp://example.com/"), "/?url=nope"]) {
    const res = await engine(path);
    expect(res.status, path).toBe(200);
    expect(res.headers.get("location"), path).toBeNull();
    expect(res.headers.get("content-type"), path).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy"), path).toContain("default-src 'none'");
    const html = await res.text();
    expect(html, path).toContain("chrome://inspect/#devices");
    expect(html, path).toContain("<code>ks.invalid:443</code>");
    expect(html, path).toContain("wss://ks.invalid/devtools/browser");
    expect(html, path).toContain("cannot reach this engine over HTTPS");
  }
});

test("the chrome://inspect page names the local host:port to configure", async () => {
  const res = await env.ENGINE.fetch("http://127.0.0.1:8787/");
  const html = await res.text();
  expect(html).toContain("<code>127.0.0.1:8787</code>");
  expect(html).toContain("ws://127.0.0.1:8787/devtools/browser");
  expect(html).not.toContain("over HTTPS");
});
