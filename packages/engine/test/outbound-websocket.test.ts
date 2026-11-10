// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, describe, expect, it } from "vitest";
import { registerCookieJar, unregisterCookieJar } from "../src/cdp/cookie-jar-registry.ts";
import {
  compileOutboundFilters,
  registerOutboundFilters,
  unregisterOutboundFilters,
} from "../src/cdp/outbound-filter-registry.ts";
import { createCookieJar } from "../src/cookies.ts";
import {
  SandboxOutbound,
  type OutboundProps,
  type SandboxOutboundEnv,
} from "../src/eval/outbound.ts";

const CONN = "ws-conn";

function upgrade(): Response {
  return new Response(null, { status: 101, webSocket: new WebSocketPair()[1] });
}

async function handshake(headers: Record<string, string>, props: Partial<OutboundProps> = {}) {
  const seen: Request[] = [];
  const resp = await SandboxOutbound.handle(
    {} as SandboxOutboundEnv,
    {
      connectionId: CONN,
      cookieKey: CONN,
      pageOrigin: "https://page.test",
      mainFrameId: "F",
      externalOutbound: {
        fetch: async (req: Request) => {
          seen.push(req);
          return upgrade();
        },
      },
      ...props,
    },
    new Request("https://socket.test/echo", { headers: { Upgrade: "websocket", ...headers } }),
  );
  return { status: resp.status, seen };
}

describe("WebSocket handshakes and outbound filters", () => {
  afterEach(() => unregisterOutboundFilters(CONN));

  const register = (rules: Parameters<typeof compileOutboundFilters>[0]) => {
    const compiled = compileOutboundFilters(rules);
    if (!compiled.ok) throw new Error(compiled.error);
    registerOutboundFilters(CONN, compiled.filters);
  };

  it.each(["Fetch", "Image", ""])("classifies a handshake labelled %j as websocket", async (t) => {
    register({ rejectResourceTypes: ["websocket"] });
    const { status, seen } = await handshake(t ? { "x-kitesurf-resource-type": t } : {});
    expect(status).toBe(451);
    expect(seen).toEqual([]);
  });

  it("does not let a fetch-only allow list admit a handshake", async () => {
    register({ allowResourceTypes: ["fetch"] });
    expect((await handshake({ "x-kitesurf-resource-type": "Fetch" })).status).toBe(451);
  });

  it("lets a websocket allow list admit a handshake", async () => {
    register({ allowResourceTypes: ["websocket"] });
    const { seen } = await handshake({ "x-kitesurf-resource-type": "Fetch" });
    expect(seen.map((r) => r.url)).toEqual(["https://socket.test/echo"]);
  });

  it.each([200, 302])("does not expose or follow a %i handshake response", async (status) => {
    const jar = createCookieJar();
    jar.setFromHeader("https://socket.test/", "sid=1; Secure; HttpOnly; SameSite=None; Path=/");
    registerCookieJar(CONN, jar);
    const sent: Request[] = [];
    try {
      await expect(
        handshake(
          {},
          {
            externalOutbound: {
              fetch: async (req) => {
                sent.push(req);
                return new Response("private", {
                  status,
                  headers: {
                    location: "https://attacker.test/",
                    "set-cookie": "secret=1",
                  },
                });
              },
            },
          },
        ),
      ).rejects.toThrow("WebSocket handshake failed");
      expect(sent[0]!.headers.get("cookie")).toBe("sid=1");
      expect(sent[0]!.redirect).toBe("manual");
    } finally {
      unregisterCookieJar(CONN);
    }
  });
});

describe("WebSocket handshake headers", () => {
  const sent = async (headers: Record<string, string>, pageOrigin = "https://page.test") => {
    const { seen } = await handshake(headers, { pageOrigin });
    expect(seen).toHaveLength(1);
    return { origin: seen[0]!.headers.get("origin"), ua: seen[0]!.headers.get("user-agent") };
  };

  it("sends the sealed page origin and a user agent", async () => {
    const { origin, ua } = await sent({});
    expect(origin).toBe("https://page.test");
    expect(ua).toBeTruthy();
  });

  it("keeps the sealed origin when the page marks the request opaque", async () => {
    const { origin, ua } = await sent({ "x-kitesurf-page-origin": "null" });
    expect(origin).toBe("https://page.test");
    expect(ua).toBeTruthy();
  });

  it("sends Origin: null for an opaque document", async () => {
    expect(await sent({}, "")).toEqual({ origin: "null", ua: expect.any(String) });
  });
});
