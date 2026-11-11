// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, it } from "vitest";
import { SandboxOutbound, type SandboxOutboundEnv } from "../src/eval/outbound.ts";

const WRITE_LABELS: [string, Record<string, string>][] = [
  ["Image", {}],
  ["Stylesheet", {}],
  ["Script", { "x-kitesurf-script-cors": "no-cors" }],
];

it.each(WRITE_LABELS)("preflights a %s-labelled cross-origin write", async (type, labels) => {
  const seen: string[] = [];
  await SandboxOutbound.handle(
    {} as SandboxOutboundEnv,
    {
      pageOrigin: "https://page.test",
      externalOutbound: {
        fetch: async (req) => {
          seen.push(req.method);
          return new Response(null, { status: 204 });
        },
      },
    },
    new Request("https://other.test/asset", {
      method: "PUT",
      body: "{}",
      headers: {
        "x-kitesurf-resource-type": type,
        "x-kitesurf-allow-cross-origin": "1",
        "content-type": "application/json",
        ...labels,
      },
    }),
  );
  expect(seen).toEqual(["OPTIONS"]);
});

it("keeps an opaque cross-origin image read", async () => {
  const gif = new Uint8Array([71, 73, 70, 56, 57, 97, 2, 0, 3, 0, 247, 0, 0]);
  const response = await SandboxOutbound.handle(
    {} as SandboxOutboundEnv,
    {
      pageOrigin: "https://page.test",
      externalOutbound: { fetch: async () => new Response(gif) },
    },
    new Request("https://other.test/asset", {
      headers: {
        "x-kitesurf-resource-type": "Image",
        "x-kitesurf-allow-cross-origin": "1",
      },
    }),
  );
  expect(response.headers.get("x-kitesurf-image-width")).toBe("2");
});

async function pageRealmResponse(response: Response, request?: Request): Promise<Response> {
  return SandboxOutbound.handle(
    {} as SandboxOutboundEnv,
    {
      pageOrigin: "https://page.test",
      pageRealm: true,
      externalOutbound: { fetch: async () => response },
    },
    request ?? new Request("https://page.test/asset"),
  );
}

it("hides forbidden response headers from a page-realm response", async () => {
  const response = await pageRealmResponse(
    new Response("body", {
      headers: {
        "set-cookie": "secret=1; HttpOnly",
        "set-cookie2": "legacy=1",
        "x-allowed": "yes",
      },
    }),
  );
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("set-cookie2")).toBeNull();
  expect(response.headers.get("x-allowed")).toBe("yes");
  expect(await response.text()).toBe("body");
});

it("hides forbidden headers on a page-realm upgrade and keeps the socket", async () => {
  const response = await pageRealmResponse(
    new Response(null, {
      status: 101,
      webSocket: new WebSocketPair()[1],
      headers: { "set-cookie": "secret=1" },
    }),
    new Request("https://page.test/socket", { headers: { Upgrade: "websocket" } }),
  );
  expect(response.status).toBe(101);
  expect(response.webSocket).toBeTruthy();
  expect(response.headers.get("set-cookie")).toBeNull();
});

it("returns a page-realm response without forbidden headers unchanged", async () => {
  const original = new Response("body", { headers: { "x-allowed": "yes" } });
  expect(await pageRealmResponse(original)).toBe(original);
});

it.each(["same-origin", "same-site"])("enforces %s CORP on a tainted script", async (policy) => {
  const response = await SandboxOutbound.handle(
    {} as SandboxOutboundEnv,
    {
      pageOrigin: "https://attacker.test",
      externalOutbound: {
        fetch: async () =>
          new Response("private()", {
            headers: { "cross-origin-resource-policy": policy },
          }),
      },
    },
    new Request("https://victim.test/script.js", {
      headers: {
        "x-kitesurf-page-origin": "null",
        "x-kitesurf-resource-type": "Script",
        "x-kitesurf-script-cors": "no-cors",
        "x-kitesurf-allow-cross-origin": "1",
      },
    }),
  );
  expect(response.status).toBe(403);
  expect(response.headers.get("x-kitesurf-blocked")).toBe("cors");
});
