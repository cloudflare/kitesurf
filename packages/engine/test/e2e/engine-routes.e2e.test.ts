// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { env } from "cloudflare:test";
import { expect, test } from "./harness";

function engine(path: string, init?: RequestInit): Promise<Response> {
  return env.ENGINE.fetch(`https://ks.invalid${path}`, {
    redirect: "manual",
    ...init,
  });
}

test("the engine has no built-in playground assets", async () => {
  for (const path of ["/index.html", "/playground.css", "/playground.js"]) {
    const response = await engine(path);
    expect(response.status, path).toBe(404);
  }
});

test("local HTTP inspection uses ws rather than wss", async () => {
  const response = await env.ENGINE.fetch("http://ks.invalid/?inspect=1", { redirect: "manual" });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.searchParams.get("ws")).toBe("ks.invalid/devtools/page/kitesurf");
  expect(location.searchParams.has("wss")).toBe(false);
});

test("/health answers OK", async () => {
  const res = await engine("/health");
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("kitesurf: OK\n");
});

test("/json/version advertises the browser WS on the request host, with or without a trailing slash", async () => {
  for (const path of ["/json/version", "/json/version/"]) {
    const res = await engine(path);
    expect(res.status, path).toBe(200);
    expect(await res.json()).toMatchObject({
      "Protocol-Version": "1.3",
      webSocketDebuggerUrl: "wss://ks.invalid/devtools/browser",
    });
  }
});

test("/json, /json/list and /json/list/ list the one synthetic page target", async () => {
  for (const path of ["/json", "/json/list", "/json/list/"]) {
    const res = await engine(path);
    expect(res.status, path).toBe(200);
    expect(await res.json()).toMatchObject([
      {
        id: "kitesurf",
        webSocketDebuggerUrl: "wss://ks.invalid/devtools/page/kitesurf",
        devtoolsFrontendUrl: "https://example.com/devtools?wss=ks.invalid/devtools/page/kitesurf",
      },
    ]);
  }
});

test("discovery without a hosted inspector advertises Chrome's bundled frontend", async () => {
  for (const protocol of ["http:", "https:"]) {
    const scheme = protocol === "https:" ? "wss" : "ws";
    for (const path of ["/json", "/json/list", "/json/list/"]) {
      const response = await env.ENGINE_NO_INSPECTOR.fetch(`${protocol}//ks.invalid${path}`);
      expect(response.status, path).toBe(200);
      // Chrome displays the target without this field, but both its Inspect
      // and Inspect fallback actions silently do nothing.
      expect(await response.json(), path).toEqual([
        expect.objectContaining({
          webSocketDebuggerUrl: `${scheme}://ks.invalid/devtools/page/kitesurf`,
          devtoolsFrontendUrl: `devtools://devtools/bundled/inspector.html?${scheme}=ks.invalid/devtools/page/kitesurf`,
        }),
      ]);
    }
  }
});

test("the web Inspect shortcut still needs a hosted frontend", async () => {
  const response = await env.ENGINE_NO_INSPECTOR.fetch("https://ks.invalid/?inspect=1");
  expect(response.status).toBe(501);
  expect(await response.text()).toContain("Inspector base URL not configured");
});

test("a path-only inspector base redirects to the request origin over wss", async () => {
  const response = await env.ENGINE_SAME_ORIGIN_INSPECTOR.fetch("https://ks.invalid/?inspect=1", {
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(
    "https://ks.invalid/inspector/inspector.html?wss=" +
      encodeURIComponent("ks.invalid/devtools/page/kitesurf"),
  );
});

test("a path-only inspector base redirects to the request origin over ws", async () => {
  const response = await env.ENGINE_SAME_ORIGIN_INSPECTOR.fetch("http://ks.invalid/?inspect=1", {
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe("http://ks.invalid/inspector/inspector.html");
  expect(location.searchParams.get("ws")).toBe("ks.invalid/devtools/page/kitesurf");
  expect(location.searchParams.has("wss")).toBe(false);
});

test("a path-only inspector base keeps the /?url= initialUrl", async () => {
  const response = await env.ENGINE_SAME_ORIGIN_INSPECTOR.fetch(
    "https://ks.invalid/?url=" + encodeURIComponent("https://example.com/"),
    { redirect: "manual" },
  );
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe("https://ks.invalid/inspector/inspector.html");
  expect(location.searchParams.get("wss")).toBe(
    "ks.invalid/devtools/page/kitesurf?initialUrl=" + encodeURIComponent("https://example.com/"),
  );
});

test("discovery advertises a path-only inspector base as a relative frontend URL", async () => {
  for (const protocol of ["http:", "https:"]) {
    const scheme = protocol === "https:" ? "wss" : "ws";
    for (const path of ["/json", "/json/list", "/json/list/"]) {
      const response = await env.ENGINE_SAME_ORIGIN_INSPECTOR.fetch(
        `${protocol}//ks.invalid${path}`,
      );
      expect(response.status, path).toBe(200);
      expect(await response.json(), path).toEqual([
        expect.objectContaining({
          webSocketDebuggerUrl: `${scheme}://ks.invalid/devtools/page/kitesurf`,
          devtoolsFrontendUrl: `/inspector/inspector.html?${scheme}=ks.invalid/devtools/page/kitesurf`,
        }),
      ]);
    }
  }
});

test("/json/protocol is an empty object", async () => {
  const res = await engine("/json/protocol");
  expect(await res.json()).toEqual({});
});

test("/?url= redirects to the inspector with the page WS and initialUrl", async () => {
  const res = await engine("/?url=" + encodeURIComponent("https://example.com/"));
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe("https://example.com/devtools");
  expect(location.searchParams.get("wss")).toBe(
    "ks.invalid/devtools/page/kitesurf?initialUrl=" + encodeURIComponent("https://example.com/"),
  );
});

test("/?ks_font_profile= carries a known profile to the page WS and drops an unknown one", async () => {
  const url = "/?url=" + encodeURIComponent("https://example.com/");
  const endpoint = async (path: string) => {
    const res = await engine(path);
    expect(res.status, path).toBe(302);
    return new URL(res.headers.get("location") ?? "").searchParams.get("wss");
  };
  expect(await endpoint(url + "&ks_font_profile=macos")).toBe(
    "ks.invalid/devtools/page/kitesurf?initialUrl=" +
      encodeURIComponent("https://example.com/") +
      "&ks_font_profile=macos",
  );
  // The landing form sends an empty value for its default option.
  for (const value of ["", "comic-sans"]) {
    expect(await endpoint(`${url}&ks_font_profile=${value}`), value).toBe(
      "ks.invalid/devtools/page/kitesurf?initialUrl=" + encodeURIComponent("https://example.com/"),
    );
  }
});

test("/?inspect=1 redirects to the inspector without an initialUrl", async () => {
  const res = await engine("/?inspect=1");
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") ?? "");
  expect(location.searchParams.get("wss")).toBe("ks.invalid/devtools/page/kitesurf");
});

test("non-upgrade /__fixtures/* requests reach the fixtures worker", async () => {
  const res = await engine("/__fixtures/inline-script.html");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("<script");
});

test("a static fixture key that names an Object.prototype property 404s", async () => {
  for (const key of ["__proto__", "constructor", "toString"]) {
    const res = await engine(`/__fixtures/${key}`);
    expect(res.status, key).toBe(404);
  }
});

test("an unknown path 404s", async () => {
  const res = await engine("/no-such-route");
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("not found");
});
