// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { buildScriptGateContext } from "@kitesurf/script-gate";
import { describe, expect, it } from "vitest";
import type { SandboxOutboundOverride } from "../src/eval/outbound.ts";
import { prefetchExternalScripts } from "../src/eval/prefetch-scripts.ts";
import { walkRedirects } from "../src/eval/redirect-walk.ts";
import { walkModuleGraph } from "../src/eval/walk-module-graph.ts";
import type { ParentScriptDescriptor } from "../src/wasm.ts";

const PAGE = "https://page.test/index.html";

function outbound(redirects: Record<string, string>) {
  const fetched: string[] = [];
  const fetcher = {
    fetch: async (req: Request) => {
      fetched.push(req.url);
      const to = redirects[req.url];
      if (to) return new Response(null, { status: 302, headers: { location: to } });
      return new Response("globalThis.ran = 1; export {};", {
        headers: { "content-type": "text/javascript" },
      });
    },
  } as Fetcher;
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only parent and final are used.
  const sandboxOutbound = {
    external: false,
    parent: () => fetcher,
    loaded: () => fetcher,
    session: () => (r: Request) => fetcher.fetch(r),
    final: async () => new Response(null, { status: 404 }),
  } as unknown as SandboxOutboundOverride;
  return { fetched, sandboxOutbound };
}

const gate = buildScriptGateContext(PAGE, { cspHeaders: ["script-src https://page.test"] });
const classic = (src: string): ParentScriptDescriptor => ({
  src,
  kind: "classic",
  defer: false,
  async: false,
  body: "",
});

describe("walkRedirects checkRedirect", () => {
  it("stops before fetching a refused target, and fetches an upgraded one", async () => {
    const { fetched, sandboxOutbound } = outbound({
      "https://page.test/a": "https://other.test/b",
      "https://page.test/c": "http://page.test/d",
    });
    const fetchHop = (r: Request) => sandboxOutbound.parent({ pageOrigin: "" }).fetch(r);
    const refused = await walkRedirects({
      url: "https://page.test/a",
      headers: {},
      fetchHop,
      checkRedirect: async () => null,
    });
    expect(refused).toEqual({ ok: false, reason: "redirect-blocked", url: "https://other.test/b" });
    const upgraded = await walkRedirects({
      url: "https://page.test/c",
      headers: {},
      fetchHop,
      checkRedirect: async (u) => u.replace("http:", "https:"),
    });
    expect(upgraded.ok && upgraded.finalUrl).toBe("https://page.test/d");
    expect(fetched).toEqual(["https://page.test/a", "https://page.test/c", "https://page.test/d"]);
  });
});

describe("classic script redirects", () => {
  const prefetch = (redirects: Record<string, string>) => {
    const { fetched, sandboxOutbound } = outbound(redirects);
    return prefetchExternalScripts({
      descriptors: [classic("https://page.test/s.js")],
      pageUrl: PAGE,
      connectionId: "",
      baseUrl: PAGE,
      sandboxOutbound,
      gate,
    }).then(([d]) => ({ d: d!, fetched }));
  };

  it.each([
    ["off script-src", "https://other.test/s.js", "csp"],
    ["over plain http", "http://page.test/s.js", "mixed-content"],
  ])("blocks a redirect %s without fetching it", async (_, to, reason) => {
    const { d, fetched } = await prefetch({ "https://page.test/s.js": to });
    expect(d.blocked?.reason).toBe(reason);
    expect(d.prefetchedSource).toBeUndefined();
    expect(fetched).toEqual(["https://page.test/s.js"]);
  });

  it("follows a redirect within script-src", async () => {
    const { d } = await prefetch({ "https://page.test/s.js": "https://page.test/t.js" });
    expect(d.blocked).toBeUndefined();
    expect(d.prefetchedSource).toContain("globalThis.ran");
  });
});

describe("module graph redirects", () => {
  it("does not bake a module whose redirect leaves script-src", async () => {
    const { fetched, sandboxOutbound } = outbound({
      "https://page.test/m.js": "https://other.test/m.js",
    });
    const { descriptors, additionalModules } = await walkModuleGraph({
      descriptors: [{ ...classic("https://page.test/m.js"), kind: "module" }],
      pageUrl: PAGE,
      connectionId: "",
      options: { gate },
      sandboxOutbound,
    });
    expect(descriptors[0]?.prefetchError).toMatch(/redirect to https:\/\/other\.test\/m\.js/);
    expect(Object.keys(additionalModules)).toEqual([]);
    expect(fetched).toEqual(["https://page.test/m.js"]);
  });
});
