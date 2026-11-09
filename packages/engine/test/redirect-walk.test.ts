// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, test } from "vitest";

import {
  InvalidRedirectError,
  MAX_REDIRECT_HOPS,
  walkRedirects,
} from "../src/eval/redirect-walk.ts";

function stubHops(chain: Record<string, { to: string } | { status: number }>) {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetchHop = async (req: Request): Promise<Response> => {
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => (headers[k] = v));
    seen.push({ url: req.url, headers });
    const hop = chain[req.url];
    if (hop && "to" in hop) {
      return new Response(null, { status: 302, headers: { location: hop.to } });
    }
    return new Response("body", { status: hop?.status ?? 200 });
  };
  return { seen, fetchHop };
}

describe("walkRedirects", () => {
  test("re-issues every hop and reports the final URL", async () => {
    const { seen, fetchHop } = stubHops({
      "https://a.test/1": { to: "https://a.test/2" },
      "https://a.test/2": { to: "https://a.test/3" },
    });
    const walk = await walkRedirects({
      url: "https://a.test/1",
      headers: {},
      fetchHop,
    });
    expect(walk.ok).toBe(true);
    if (!walk.ok) return;
    expect(walk.finalUrl).toBe("https://a.test/3");
    expect(walk.hops).toBe(2);
    expect(seen.map((s) => s.url)).toEqual([
      "https://a.test/1",
      "https://a.test/2",
      "https://a.test/3",
    ]);
  });

  test.each([
    ["follows the hop", null],
    ["stops at a blocked hop", () => null],
  ])("cancels a redirect's body when it %s", async (_, checkRedirect) => {
    const cancelled: string[] = [];
    const fetchHop = async (req: Request): Promise<Response> => {
      const body = new ReadableStream({ cancel: () => void cancelled.push(req.url) });
      if (req.url !== "https://a.test/1") return new Response(body);
      return new Response(body, { status: 302, headers: { location: "https://a.test/2" } });
    };
    await walkRedirects({
      url: "https://a.test/1",
      headers: {},
      fetchHop,
      ...(checkRedirect ? { checkRedirect } : {}),
    });
    await Promise.resolve();
    expect(cancelled).toEqual(["https://a.test/1"]);
  });

  test("Authorization is dropped on a cross-origin hop and stays dropped", async () => {
    const { seen, fetchHop } = stubHops({
      "https://a.test/1": { to: "https://b.test/2" },
      "https://b.test/2": { to: "https://a.test/3" },
    });
    await walkRedirects({
      url: "https://a.test/1",
      headers: { authorization: "Bearer secret" },
      fetchHop,
    });
    expect(seen[0]?.headers["authorization"]).toBe("Bearer secret");
    expect(seen[1]?.headers["authorization"]).toBeUndefined();
    expect(seen[2]?.headers["authorization"]).toBeUndefined();
  });

  test("Authorization survives same-origin hops", async () => {
    const { seen, fetchHop } = stubHops({
      "https://a.test/1": { to: "https://a.test/2" },
    });
    await walkRedirects({
      url: "https://a.test/1",
      headers: { authorization: "Bearer secret" },
      fetchHop,
    });
    expect(seen[1]?.headers["authorization"]).toBe("Bearer secret");
  });

  describe("origin taint", () => {
    test("a same-origin entry redirecting to a CDN keeps the real origin", async () => {
      const { seen, fetchHop } = stubHops({
        "https://a.test/1": { to: "https://cdn.test/2" },
      });
      await walkRedirects({
        url: "https://a.test/1",
        headers: { origin: "https://a.test" },
        taintOriginFrom: "https://a.test",
        fetchHop,
      });
      expect(seen[1]?.headers["origin"]).toBe("https://a.test");
    });

    test("a cross-origin entry hopping origins again taints, stickily", async () => {
      const { seen, fetchHop } = stubHops({
        "https://b.test/1": { to: "https://c.test/2" },
        "https://c.test/2": { to: "https://a.test/3" },
      });
      await walkRedirects({
        url: "https://b.test/1",
        headers: { origin: "https://a.test" },
        taintOriginFrom: "https://a.test",
        fetchHop,
      });
      expect(seen[1]?.headers["origin"]).toBe("null");
      expect(seen[1]?.headers["x-kitesurf-page-origin"]).toBe("null");
      expect(seen[2]?.headers["origin"]).toBe("null");
    });

    test("no taint at all when the caller doesn't opt in", async () => {
      const { seen, fetchHop } = stubHops({
        "https://a.test/1": { to: "https://b.test/2" },
      });
      await walkRedirects({
        url: "https://a.test/1",
        headers: { "x-kitesurf-page-origin": "https://a.test" },
        fetchHop,
      });
      expect(seen[1]?.headers["x-kitesurf-page-origin"]).toBe("https://a.test");
    });
  });

  test("Sec-Fetch-Site and Referer are corrected on a cross-origin hop", async () => {
    const { seen, fetchHop } = stubHops({
      "https://a.test/1": { to: "https://b.test/2" },
    });
    await walkRedirects({
      url: "https://a.test/1",
      headers: {
        "sec-fetch-site": "same-origin",
        referer: "https://a.test/secret/path?token=abc",
      },
      fetchHop,
    });
    expect(seen[1]?.headers["sec-fetch-site"]).toBe("cross-site");
    expect(seen[1]?.headers["referer"]).toBe("https://a.test/");
  });

  test("a 303 rewrites POST to GET and strips the entity headers", async () => {
    const seen: Request[] = [];
    const walk = await walkRedirects({
      url: "https://a.test/post",
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
      headers: { "content-type": "application/json", "content-length": "3" },
      fetchHop: async (req) => {
        seen.push(req);
        if (seen.length === 1) {
          return new Response(null, {
            status: 303,
            headers: { location: "https://a.test/done" },
          });
        }
        return new Response("ok", { status: 200 });
      },
    });
    expect(walk.ok).toBe(true);
    expect(seen[1]?.method).toBe("GET");
    expect(seen[1]?.headers.get("content-type")).toBeNull();
    expect(seen[1]?.headers.get("content-length")).toBeNull();
  });

  test("a 307 preserves the method and body", async () => {
    const seen: Request[] = [];
    await walkRedirects({
      url: "https://a.test/post",
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
      headers: {},
      fetchHop: async (req) => {
        seen.push(req);
        if (seen.length === 1) {
          return new Response(null, {
            status: 307,
            headers: { location: "https://a.test/done" },
          });
        }
        return new Response("ok", { status: 200 });
      },
    });
    expect(seen[1]?.method).toBe("POST");
  });

  test("the hop cap is a value, not a throw", async () => {
    const fetchHop = async (_req: Request) =>
      new Response(null, {
        status: 302,
        headers: { location: `https://a.test/${Math.random()}` },
      });
    const walk = await walkRedirects({
      url: "https://a.test/0",
      headers: {},
      fetchHop,
    });
    expect(walk.ok).toBe(false);
    if (walk.ok) return;
    expect(walk.reason).toBe("too-many-redirects");
  });

  test("the cap is honoured exactly", async () => {
    let n = 0;
    const walk = await walkRedirects({
      url: "https://a.test/0",
      headers: {},
      fetchHop: async () => {
        n += 1;
        if (n <= MAX_REDIRECT_HOPS) {
          return new Response(null, {
            status: 302,
            headers: { location: `https://a.test/${n}` },
          });
        }
        return new Response("ok", { status: 200 });
      },
    });
    expect(walk.ok).toBe(true);
    if (!walk.ok) return;
    expect(walk.hops).toBe(MAX_REDIRECT_HOPS);
  });

  test("a non-http Location scheme throws", async () => {
    await expect(
      walkRedirects({
        url: "https://a.test/1",
        headers: {},
        fetchHop: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "data:text/html,hi" },
          }),
      }),
    ).rejects.toBeInstanceOf(InvalidRedirectError);
  });

  test("a 3xx with no Location is the terminal response", async () => {
    const walk = await walkRedirects({
      url: "https://a.test/1",
      headers: {},
      fetchHop: async () => new Response("body", { status: 302 }),
    });
    expect(walk.ok).toBe(true);
    if (!walk.ok) return;
    expect(walk.hops).toBe(0);
    expect(walk.finalUrl).toBe("https://a.test/1");
  });

  test("cookies are recomputed per hop, against the host being contacted", async () => {
    const asked: string[] = [];
    const { seen, fetchHop } = stubHops({
      "https://b.test/1": { to: "https://c.test/2" },
    });
    await walkRedirects({
      url: "https://b.test/1",
      headers: {},
      cookieHeaderFor: (url) => {
        asked.push(url);
        return url.startsWith("https://b.test/") ? "sid=1" : undefined;
      },
      fetchHop,
    });
    expect(asked).toEqual(["https://b.test/1", "https://c.test/2"]);
    expect(seen[0]?.headers["cookie"]).toBe("sid=1");
    expect(seen[1]?.headers["cookie"]).toBeUndefined();
  });

  test("a caller's own Cookie does not survive a cross-origin hop", async () => {
    const { seen, fetchHop } = stubHops({
      "https://a.test/1": { to: "https://a.test/2" },
      "https://a.test/2": { to: "https://evil.test/3" },
    });
    await walkRedirects({
      url: "https://a.test/1",
      headers: { Cookie: "sid=secret" },
      cookieHeaderFor: () => undefined,
      fetchHop,
    });
    expect(seen[0]?.headers["cookie"]).toBe("sid=secret");
    expect(seen[1]?.headers["cookie"]).toBe("sid=secret");
    expect(seen[2]?.headers["cookie"]).toBeUndefined();
  });

  test("a chain returning to the entry origin does not resurrect the Cookie", async () => {
    const { seen, fetchHop } = stubHops({
      "https://a.test/1": { to: "https://b.test/2" },
      "https://b.test/2": { to: "https://a.test/3" },
    });
    await walkRedirects({
      url: "https://a.test/1",
      headers: { cookie: "sid=secret" },
      cookieHeaderFor: () => undefined,
      fetchHop,
    });
    expect(seen[1]?.headers["cookie"]).toBeUndefined();
    expect(seen[2]?.headers["cookie"]).toBeUndefined();
  });

  test("the jar still wins over the caller's Cookie on the entry origin", async () => {
    const { seen, fetchHop } = stubHops({
      "https://a.test/1": { to: "https://a.test/2" },
    });
    await walkRedirects({
      url: "https://a.test/1",
      headers: { Cookie: "sid=caller" },
      cookieHeaderFor: () => "sid=jar",
      fetchHop,
    });
    expect(seen[1]?.headers["cookie"]).toBe("sid=jar");
  });

  test("an already-aborted signal stops the walk without a fetch", async () => {
    let calls = 0;
    await expect(
      walkRedirects({
        url: "https://a.test/1",
        headers: {},
        signal: AbortSignal.abort(),
        fetchHop: async () => {
          calls += 1;
          return new Response("ok");
        },
      }),
    ).rejects.toBeTruthy();
    expect(calls).toBe(0);
  });
});
