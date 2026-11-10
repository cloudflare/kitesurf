// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect, beforeEach } from "vitest";
import {
  CARRIED_STATUS_HEADER,
  SandboxOutbound,
  corsFilteredResponse,
  rpcSafeResponse,
} from "../src/eval/outbound.ts";
import { walkRedirects } from "../src/eval/redirect-walk.ts";
import { NetworkEventTracker } from "../src/cdp/network-events.ts";
import { registerTracker, unregisterTracker } from "../src/cdp/network-events-registry.ts";
import {
  clearPreflightCache,
  corsCheck,
  corsPreflight,
  corsUnsafeRequestHeaderNames,
  filterCorsResponseHeaders,
  isSafelistedRequestHeader,
  needsPreflight,
  parseTokenList,
  preflightCacheLookup,
} from "../src/eval/cors.ts";

const ORIGIN = "http://web-platform.test:8000";
const PARTITION = "connection-a";

describe("stylesheet response MIME", () => {
  it.each([
    ["cross-origin nosniff", "http://remote.test/sheet", "text/plain", "nosniff", 403, null],
    ["cross-origin JSON", "http://remote.test/sheet", "application/json", "", 403, null],
    ["opaque CSS", "http://remote.test/sheet", "text/css", "", 200, "opaque"],
    ["CSS with params", "http://remote.test/sheet", "text/css; charset", "", 200, "opaque"],
    ["cross-origin no MIME", "http://remote.test/sheet", "", "", 200, "opaque"],
    ["cross-origin no MIME nosniff", "http://remote.test/sheet", "", "nosniff", 403, null],
    ["same-origin nosniff", `${ORIGIN}/sheet`, "text/plain", "nosniff", 403, null],
    ["redirect to cross-origin", `${ORIGIN}/redirect`, "text/plain", "", 403, null],
  ])("%s", async (_name, url, type, nosniff, status, verdict) => {
    const result = await walkRedirects({
      url,
      headers: { "x-kitesurf-resource-type": "Stylesheet", "x-kitesurf-allow-cross-origin": "1" },
      fetchHop: (request) =>
        SandboxOutbound.handle(
          { FONT_ASSETS: { fetch: async () => new Response() } },
          {
            pageOrigin: ORIGIN,
            externalOutbound: {
              fetch: async (hop) =>
                hop.url.endsWith("/redirect")
                  ? new Response("redirect", {
                      status: 302,
                      headers: {
                        location: "http://remote.test/sheet",
                        "content-type": "text/plain",
                      },
                    })
                  : new Response("secret{color:red}", {
                      headers: { "content-type": type, "x-content-type-options": nosniff },
                    }),
            },
          },
          request,
        ),
    });
    if (!result.ok) throw new Error(`redirect walk failed: ${result.reason}`);
    expect(result.response.status).toBe(status);
    expect(result.response.headers.get("x-kitesurf-cors")).toBe(verdict);
    expect((await result.response.text()).includes("secret{color:red}")).toBe(status === 200);
  });

  // An error page is a response the page and DevTools must see, not a network failure: only a
  // 2xx body that would apply as CSS is refused for its MIME type.
  type SheetEvent = { method: string; status?: number; errorText?: string };
  async function trackedSheet(status: number, type: string, nosniff: string) {
    const events: SheetEvent[] = [];
    const tracker = new NetworkEventTracker((ev) => {
      if (ev.method === "Network.responseReceived") {
        events.push({ method: ev.method, status: ev.params.response.status });
      } else if (ev.method === "Network.loadingFailed") {
        events.push({ method: ev.method, errorText: ev.params.errorText });
      }
    }, PARTITION);
    tracker.setEnabled(undefined, true);
    registerTracker(PARTITION, tracker);
    try {
      const response = await SandboxOutbound.handle(
        { FONT_ASSETS: { fetch: async () => new Response() } },
        {
          pageOrigin: ORIGIN,
          connectionId: PARTITION,
          externalOutbound: {
            fetch: async () =>
              new Response("secret{color:red}", {
                status,
                headers: { "content-type": type, "x-content-type-options": nosniff },
              }),
          },
        },
        new Request("http://remote.test/sheet", {
          headers: {
            "x-kitesurf-resource-type": "Stylesheet",
            "x-kitesurf-allow-cross-origin": "1",
          },
        }),
      );
      tracker.drain();
      return { response, events };
    } finally {
      tracker.dispose();
      unregisterTracker(PARTITION);
    }
  }

  it("reports an error page's status instead of a network failure", async () => {
    const { response, events } = await trackedSheet(404, "text/html", "nosniff");
    expect(response.status).toBe(404);
    expect(events).toEqual([{ method: "Network.responseReceived", status: 404 }]);
  });

  it("still refuses a 200 body that would not apply as CSS", async () => {
    const { response, events } = await trackedSheet(200, "text/html", "nosniff");
    expect(response.status).toBe(403);
    expect(events).toEqual([{ method: "Network.loadingFailed", errorText: "stylesheet-mime" }]);
  });
});

describe("parseTokenList", () => {
  it("drops empty items and keeps tokens", () => {
    expect(parseTokenList(",bb-8")).toEqual(["bb-8"]);
    expect(parseTokenList("bb-8, no")).toEqual(["bb-8", "no"]);
    expect(parseTokenList("")).toEqual([]);
  });

  it("fails the whole list on any non-token item", () => {
    expect(parseTokenList("bb-8,,@#$#%%&^&^*()()11!")).toBeNull();
    expect(parseTokenList("bb-8, no no")).toBeNull();
    expect(parseTokenList('"bb-8",bb-8')).toBeNull();
  });

  it("treats \\v / \\f as significant and quotes as token chars", () => {
    expect(parseTokenList("bb-8\u000B")).toBeNull();
    expect(parseTokenList("bb-8\u000C")).toBeNull();
    expect(parseTokenList("'bb-8'")).toEqual(["'bb-8'"]);
    expect(parseTokenList("\tbb-8 ")).toEqual(["bb-8"]);
  });

  it("returns null for an absent header", () => {
    expect(parseTokenList(null)).toBeNull();
  });
});

describe("isSafelistedRequestHeader: content-type", () => {
  const cases: Array<[string, boolean]> = [
    ["text/plain", true],
    ["text/plain;", true],
    ["text/plain;garbage", true],
    ["multipart/form-data", true],
    ["application/x-www-form-urlencoded", true],
    ["text /plain", false],
    ["text\t/\tplain", false],
    ["text/plain,", false],
    [",text/plain", false],
    ["text/plain,text/plain", false],
    ["text/plain;garbage\u0001\u0002", false],
    ["text/plain\u000B", false],
    ["application/x-www-form-urlencoded;\u007F", false],
    ['multipart/form-data;"', false],
    ["application/www-form-urlencoded", false],
  ];
  for (const [value, expected] of cases) {
    it(`${JSON.stringify(value)} → ${expected}`, () => {
      expect(isSafelistedRequestHeader("content-type", value)).toBe(expected);
    });
  }
});

describe("isSafelistedRequestHeader: range", () => {
  const cases: Array<[string, boolean]> = [
    ["bytes=100-200", true],
    ["bytes=200-", true],
    ["100-200", false],
    ["MB=100-200", false],
    ["bytes =100-200", false],
    ["bytes=  100-200", false],
    ["bytes=100 -200", false],
    ["bytes=-200", false],
    ["bytes=200-100", false],
    ["bytes=100-200,300-400", false],
    ["bytes=abc-def", false],
    [`bytes=1${"0".repeat(60)}-2${"0".repeat(60)}`, false],
  ];
  for (const [value, expected] of cases) {
    it(`${JSON.stringify(value)} → ${expected}`, () => {
      expect(isSafelistedRequestHeader("range", value)).toBe(expected);
    });
  }
});

describe("isSafelistedRequestHeader: other names", () => {
  it("accept rejects only CORS-unsafe bytes", () => {
    expect(isSafelistedRequestHeader("accept", "test")).toBe(true);
    expect(isSafelistedRequestHeader("accept", '"')).toBe(false);
  });

  it("accept-language is limited to its own byte set", () => {
    expect(isSafelistedRequestHeader("accept-language", "nn")).toBe(true);
    expect(isSafelistedRequestHeader("accept-language", "@")).toBe(false);
  });

  it("anything else is unsafe", () => {
    expect(isSafelistedRequestHeader("authorization", "basics")).toBe(false);
    expect(isSafelistedRequestHeader("x-test", "hi")).toBe(false);
  });

  it("caps every value at 128 bytes", () => {
    expect(isSafelistedRequestHeader("accept", "a".repeat(129))).toBe(false);
  });
});

describe("needsPreflight / corsUnsafeRequestHeaderNames", () => {
  it("skips UA-owned and internal headers", () => {
    const h = new Headers({
      origin: ORIGIN,
      referer: `${ORIGIN}/`,
      "x-kitesurf-page-origin": ORIGIN,
      "sec-fetch-mode": "cors",
      accept: "test",
    });
    expect(corsUnsafeRequestHeaderNames(h)).toEqual([]);
    expect(needsPreflight("GET", h)).toBe(false);
  });

  it("does not count the headers a fetch cache mode adds as the page's", () => {
    const fromMode = new Headers({
      "cache-control": "no-cache",
      pragma: "no-cache",
      "x-kitesurf-cache-mode": "pragma,cache-control",
    });
    expect(needsPreflight("GET", fromMode)).toBe(false);
    const fromPage = new Headers({ "cache-control": "no-cache", pragma: "no-cache" });
    expect(corsUnsafeRequestHeaderNames(fromPage)).toEqual(["cache-control", "pragma"]);
    // The page set cache-control itself; the mode added only pragma.
    const mixed = new Headers({
      "cache-control": "no-cache",
      pragma: "no-cache",
      "x-kitesurf-cache-mode": "pragma",
    });
    expect(corsUnsafeRequestHeaderNames(mixed)).toEqual(["cache-control"]);
    // The mark covers only the two cache headers, whatever it names.
    const spoofed = new Headers({ "x-custom": "1", "x-kitesurf-cache-mode": "x-custom" });
    expect(corsUnsafeRequestHeaderNames(spoofed)).toEqual(["x-custom"]);
  });

  it("reports author headers lowercased and sorted", () => {
    const h = new Headers({ "Y-Print": "b", "X-Print": "a" });
    expect(corsUnsafeRequestHeaderNames(h)).toEqual(["x-print", "y-print"]);
  });

  it("a non-safelisted method preflights on its own", () => {
    expect(needsPreflight("PUT", new Headers())).toBe(true);
    expect(needsPreflight("post", new Headers())).toBe(false);
  });
});

describe("corsCheck", () => {
  const withHeaders = (h: Record<string, string>) => new Headers(h);

  it("requires the header to be present", () => {
    expect(corsCheck(withHeaders({}), ORIGIN, false)).toBe("cors-missing-origin");
  });

  it("accepts the wildcard only without credentials", () => {
    expect(
      corsCheck(withHeaders({ "access-control-allow-origin": "*" }), ORIGIN, false),
    ).toBeNull();
    expect(corsCheck(withHeaders({ "access-control-allow-origin": "*" }), ORIGIN, true)).toBe(
      "cors-wildcard-with-credentials",
    );
  });

  it("accepts an exact echo, including the opaque 'null'", () => {
    expect(
      corsCheck(withHeaders({ "access-control-allow-origin": ORIGIN }), ORIGIN, false),
    ).toBeNull();
    expect(
      corsCheck(withHeaders({ "access-control-allow-origin": "null" }), "null", false),
    ).toBeNull();
  });

  it("strips HTTP whitespace only, so \\v and \\f stay significant", () => {
    expect(
      corsCheck(withHeaders({ "access-control-allow-origin": " *\t" }), ORIGIN, false),
    ).toBeNull();
    expect(
      corsCheck(withHeaders({ "access-control-allow-origin": "\u000C*" }), ORIGIN, false),
    ).toBe("cors-origin-mismatch");
    expect(
      corsCheck(withHeaders({ "access-control-allow-origin": "*\u000B" }), ORIGIN, false),
    ).toBe("cors-origin-mismatch");
  });

  it("names the multiple-values case separately", () => {
    expect(
      corsCheck(withHeaders({ "access-control-allow-origin": `${ORIGIN}, *` }), ORIGIN, false),
    ).toBe("cors-multiple-origins");
  });

  it("demands a literal 'true' Allow-Credentials in include mode", () => {
    const base = { "access-control-allow-origin": ORIGIN };
    expect(corsCheck(withHeaders(base), ORIGIN, true)).toBe("cors-credentials-not-allowed");
    expect(
      corsCheck(withHeaders({ ...base, "access-control-allow-credentials": "TRUE" }), ORIGIN, true),
    ).toBe("cors-credentials-not-allowed");
    expect(
      corsCheck(withHeaders({ ...base, "access-control-allow-credentials": "true" }), ORIGIN, true),
    ).toBeNull();
  });
});

describe("filterCorsResponseHeaders", () => {
  const source = () =>
    new Headers({
      "content-type": "text/plain",
      "cache-control": "no-cache",
      server: "wptserve",
      "x-custom": "yes",
      "x-nonexposed": "no",
    });

  it("keeps the safelist and drops everything unexposed", () => {
    const out = filterCorsResponseHeaders(source(), false);
    expect(out.get("content-type")).toBe("text/plain");
    expect(out.get("cache-control")).toBe("no-cache");
    expect(out.get("server")).toBeNull();
    expect(out.get("x-custom")).toBeNull();
  });

  it("exposes explicitly listed names, case-insensitively", () => {
    const h = source();
    h.set("access-control-expose-headers", "X-Custom");
    const out = filterCorsResponseHeaders(h, false);
    expect(out.get("x-custom")).toBe("yes");
    expect(out.get("x-nonexposed")).toBeNull();
  });

  it("honours the wildcard, but not in credentialed mode", () => {
    const h = source();
    h.set("access-control-expose-headers", "*");
    expect(filterCorsResponseHeaders(h, false).get("x-custom")).toBe("yes");
    expect(filterCorsResponseHeaders(h, true).get("x-custom")).toBeNull();
  });

  it("never exposes Set-Cookie, even when listed", () => {
    const h = source();
    h.set("set-cookie", "a=1");
    h.set("access-control-expose-headers", "set-cookie, *");
    expect(filterCorsResponseHeaders(h, false).get("set-cookie")).toBeNull();
  });

  it("never exposes the x-kitesurf-* plumbing namespace", () => {
    const h = source();
    h.set("x-kitesurf-status", "699");
    h.set("access-control-expose-headers", "x-kitesurf-status, *");
    const out = filterCorsResponseHeaders(h, false);
    expect(out.get("x-kitesurf-status")).toBeNull();
  });

  it("exposes nothing extra when the header fails to parse", () => {
    const h = source();
    h.set("access-control-expose-headers", 'x-custom, "bad"');
    expect(filterCorsResponseHeaders(h, false).get("x-custom")).toBeNull();
  });
});

describe("corsPreflight", () => {
  beforeEach(() => clearPreflightCache());

  const reply = (headers: Record<string, string>, status = 200) =>
    new Response(null, { status, headers });

  function run(
    responder: (req: Request) => Response,
    opts: {
      method?: string;
      unsafe?: string[];
      credentials?: boolean;
      url?: string;
      partition?: string;
    } = {},
  ) {
    const seen: Request[] = [];
    const promise = corsPreflight(
      {
        partition: opts.partition ?? PARTITION,
        url: opts.url ?? "http://remote.test/x",
        method: opts.method ?? "PUT",
        unsafeNames: opts.unsafe ?? [],
        requestOrigin: ORIGIN,
        credentialsInclude: opts.credentials ?? false,
        userAgent: "UA/1",
        referer: null,
        signal: new AbortController().signal,
      },
      async (req) => {
        seen.push(req);
        return responder(req);
      },
    );
    return { promise, seen };
  }

  it("propagates the caller's abort signal onto the OPTIONS", async () => {
    const { promise, seen } = run(() =>
      reply({ "access-control-allow-origin": ORIGIN, "access-control-allow-methods": "PUT" }),
    );
    await promise;
    const [options] = seen;
    if (options === undefined) throw new Error("no preflight was issued");
    expect(options.signal).toBeDefined();
  });

  it("sends OPTIONS with the spec's request headers", async () => {
    const { promise, seen } = run(
      () =>
        reply({
          "access-control-allow-origin": ORIGIN,
          "access-control-allow-methods": "PUT",
          "access-control-allow-headers": "x-test",
        }),
      { unsafe: ["x-test"] },
    );
    expect((await promise).reason).toBeNull();
    const [options] = seen;
    if (options === undefined) throw new Error("no preflight was issued");
    expect(options.method).toBe("OPTIONS");
    expect(options.headers.get("origin")).toBe(ORIGIN);
    expect(options.headers.get("access-control-request-method")).toBe("PUT");
    expect(options.headers.get("access-control-request-headers")).toBe("x-test");
    expect(options.headers.get("accept")).toBe("*/*");
  });

  it("rejects a non-2xx preflight", async () => {
    const { promise } = run(() => reply({ "access-control-allow-origin": ORIGIN }, 400));
    expect((await promise).reason).toBe("cors-preflight-status");
  });

  it("treats absent Allow-Methods / Allow-Headers as empty, not as failure", async () => {
    const { promise } = run(() => reply({ "access-control-allow-origin": ORIGIN }), {
      method: "GET",
    });
    expect((await promise).reason).toBeNull();
  });

  it("rejects an unparseable Allow-Headers", async () => {
    const { promise } = run(
      () =>
        reply({
          "access-control-allow-origin": ORIGIN,
          "access-control-allow-headers": 'x-test, "bad"',
        }),
      { unsafe: ["x-test"] },
    );
    expect((await promise).reason).toBe("cors-preflight-invalid-header");
  });

  it("compares methods byte-for-byte", async () => {
    const { promise } = run(() =>
      reply({
        "access-control-allow-origin": ORIGIN,
        "access-control-allow-methods": "put",
      }),
    );
    expect((await promise).reason).toBe("cors-method-not-allowed");
  });

  it("ignores the method wildcard in credentialed mode", async () => {
    const headers = {
      "access-control-allow-origin": ORIGIN,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "*",
    };
    expect((await run(() => reply(headers)).promise).reason).toBeNull();
    expect((await run(() => reply(headers), { credentials: true }).promise).reason).toBe(
      "cors-method-not-allowed",
    );
  });

  it("never lets the header wildcard cover Authorization", async () => {
    const headers = {
      "access-control-allow-origin": ORIGIN,
      "access-control-allow-methods": "PUT",
      "access-control-allow-headers": "*",
    };
    expect((await run(() => reply(headers), { unsafe: ["x-test"] }).promise).reason).toBeNull();
    expect((await run(() => reply(headers), { unsafe: ["authorization"] }).promise).reason).toBe(
      "cors-header-not-allowed",
    );
  });

  it("caches only when Max-Age says so", async () => {
    const headers = {
      "access-control-allow-origin": ORIGIN,
      "access-control-allow-methods": "PUT",
      "access-control-max-age": "600",
    };
    const url = "http://remote.test/cached";
    expect((await run(() => reply(headers), { url }).promise).reason).toBeNull();
    expect(preflightCacheLookup(PARTITION, ORIGIN, url, "PUT", [], false)).toBe(true);
    expect(preflightCacheLookup(PARTITION, ORIGIN, url, "PUT", [], true)).toBe(false);
    expect(preflightCacheLookup(PARTITION, ORIGIN, url, "PUT", ["x-test"], false)).toBe(false);
  });

  // The cache is shared by every session in the isolate, so a grant must not
  // cross a browser context boundary.
  const otherPartitions = ["connection-b", "connection-a::context-b"];
  it.each(otherPartitions)("does not reuse a grant in %s", async (other) => {
    const url = "https://target.test/partition";
    const headers = {
      "access-control-allow-origin": ORIGIN,
      "access-control-allow-methods": "PUT",
      "access-control-max-age": "600",
    };
    const { promise } = run(() => reply(headers), { url, partition: PARTITION });
    expect((await promise).reason).toBeNull();
    expect(preflightCacheLookup(other, ORIGIN, url, "PUT", [], false)).toBe(false);
  });

  // A host egress hook can answer for any server, and the cache is
  // shared by every session in the isolate, so its grants must never land there.
  it("never caches a grant the caller marks uncacheable", async () => {
    const url = "http://remote.test/host-egress";
    const verdict = await corsPreflight(
      {
        partition: PARTITION,
        url,
        method: "PUT",
        unsafeNames: [],
        requestOrigin: ORIGIN,
        credentialsInclude: false,
        userAgent: "UA/1",
        referer: null,
        signal: new AbortController().signal,
        cacheable: false,
      },
      async () =>
        reply({
          "access-control-allow-origin": ORIGIN,
          "access-control-allow-methods": "PUT",
          "access-control-max-age": "600",
        }),
    );
    expect(verdict.reason).toBeNull();
    expect(preflightCacheLookup(PARTITION, ORIGIN, url, "PUT", [], false)).toBe(false);
  });

  // Max-Age is delta-seconds; Number() would have accepted all of these
  // and cached off a value the server never validly stated. Surrounding
  // whitespace is NOT in the list: the header layer strips OWS, so
  // " 12 " legitimately arrives as "12" and is a valid Max-Age.
  it("rejects a Max-Age that isn't delta-seconds", async () => {
    for (const bad of ["1.5", "1e3", "0x10", "+12", "-1", "12s", ""]) {
      clearPreflightCache();
      const url = `http://remote.test/maxage-${encodeURIComponent(bad)}`;
      const { promise } = run(
        () =>
          reply({
            "access-control-allow-origin": ORIGIN,
            "access-control-allow-methods": "PUT",
            "access-control-max-age": bad,
          }),
        { url },
      );
      expect((await promise).reason).toBeNull();
      expect(preflightCacheLookup(PARTITION, ORIGIN, url, "PUT", [], false)).toBe(false);
    }
  });

  it("skips the cache when Max-Age is absent or zero", async () => {
    const url = "http://remote.test/uncached";
    const { promise } = run(
      () =>
        reply({
          "access-control-allow-origin": ORIGIN,
          "access-control-allow-methods": "PUT",
          "access-control-max-age": "0",
        }),
      { url },
    );
    expect((await promise).reason).toBeNull();
    expect(preflightCacheLookup(PARTITION, ORIGIN, url, "PUT", [], false)).toBe(false);
  });
});

describe("corsFilteredResponse", () => {
  const source = () =>
    new Response("body", {
      status: 200,
      headers: { "content-type": "text/plain", server: "wptserve", "x-secret": "no" },
    });

  it("keeps an in-range status on the rebuilt response", () => {
    const src = source();
    const out = corsFilteredResponse(src, "body", filterCorsResponseHeaders(src.headers, false));
    expect(out.status).toBe(200);
    expect(out.headers.get(CARRIED_STATUS_HEADER)).toBeNull();
    expect(out.headers.get("x-secret")).toBeNull();
  });

  it("carries an out-of-range status instead of returning raw headers", () => {
    const src = new Response("body", {
      status: 599,
      headers: { "content-type": "text/plain", server: "wptserve", "x-secret": "no" },
    });
    Object.defineProperty(src, "status", { value: 699, configurable: true });
    const out = corsFilteredResponse(src, "body", filterCorsResponseHeaders(src.headers, false));
    expect(out.headers.get(CARRIED_STATUS_HEADER)).toBe("699");
    expect(out.headers.get("server")).toBeNull();
    expect(out.headers.get("x-secret")).toBeNull();
    expect(out.headers.get("content-type")).toBe("text/plain");
  });
});

describe("rpcSafeResponse", () => {
  const withStatus = (status: number) => {
    const r = new Response("body", { status: 599, headers: { "x-origin": "kept" } });
    Object.defineProperty(r, "status", { value: status, configurable: true });
    return r;
  };

  it("passes an in-range response through untouched", () => {
    const src = new Response("body", { status: 404 });
    expect(rpcSafeResponse(src)).toBe(src);
  });

  it("carries 699 with its headers and body", async () => {
    const out = rpcSafeResponse(withStatus(699));
    expect(out.status).toBe(599);
    expect(out.headers.get(CARRIED_STATUS_HEADER)).toBe("699");
    expect(out.headers.get("x-origin")).toBe("kept");
    expect(await out.text()).toBe("body");
  });

  it("carries 101 without a body", async () => {
    const out = rpcSafeResponse(withStatus(101));
    expect(out.headers.get(CARRIED_STATUS_HEADER)).toBe("101");
    expect(await out.text()).toBe("");
  });

  it("fails any other 1xx like a network error", () => {
    expect(() => rpcSafeResponse(withStatus(103))).toThrow(TypeError);
  });
});
