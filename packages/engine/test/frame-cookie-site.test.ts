// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const spawned: Array<Record<string, unknown>> = [];
vi.mock("../src/eval/page-script.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/eval/page-script.ts")>()),
  spawnFramePageScript: (_env: unknown, _ctx: unknown, args: Record<string, unknown>) => {
    spawned.push(args);
    return { queryDom: async () => ({}), unload: async () => {}, close: () => {} };
  },
}));

// The frame's meta CSP comes from the document scan, which needs the core wasm instance the
// unit-test embedder disallows. This test is about cookie attribution, so it scans nothing.
vi.mock("../src/wasm.ts", () => ({
  scanDocument: () => ({ baseHref: null, metaCsp: [], modulePreloads: [] }),
  extractScriptDescriptorsFromDom: () => [],
  createDom: () => {
    throw new Error("test harness: createDom is unused");
  },
}));

import { registerCookieJar, unregisterCookieJar } from "../src/cdp/cookie-jar-registry.ts";
import { makeChildFrameState, makeMainFrameState } from "../src/cdp/frames.ts";
import { frameCookieSiteOrigin } from "../src/cdp/page.ts";
import type { FrameState, TargetState } from "../src/cdp/types.ts";
import { createCookieJar } from "../src/cookies.ts";
import { frameDocumentCookieSite, prespawnFrameIsolate } from "../src/eval/oopif-render.ts";
import {
  createSandboxOutboundOverride,
  type SandboxOutboundEnv,
  type SandboxOutboundExports,
} from "../src/eval/outbound.ts";

const CONN = "frame-cookie-site";
const FRAME = "https://frame.test";

afterEach(() => {
  unregisterCookieJar(CONN);
  spawned.length = 0;
});

async function frameDocumentCookies(cookieSiteOrigin: string) {
  const seen: Request[] = [];
  const jar = createCookieJar();
  for (const [name, attrs] of [
    ["strict", "; SameSite=Strict"],
    ["lax", "; SameSite=Lax"],
    ["none", "; SameSite=None"],
    ["dflt", ""],
  ]) {
    jar.setFromHeader(`${FRAME}/login`, `${name}=1; Secure; Path=/${attrs}`);
  }
  registerCookieJar(CONN, jar);
  const sandboxOutbound = createSandboxOutboundOverride(
    {} as SandboxOutboundExports,
    {} as SandboxOutboundEnv,
    {
      fetch: async (req: Request) => {
        seen.push(req);
        return new Response("<p>frame</p>", { headers: { "content-type": "text/html" } });
      },
    },
  );
  const r = await prespawnFrameIsolate(
    { LOADER: {} as WorkerLoader },
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- prespawn only passes ctx on.
    { waitUntil: () => {} } as unknown as ExecutionContext,
    {
      connectionId: CONN,
      cookieKey: CONN,
      sandboxOutbound,
      targetId: "T",
      frameId: "C",
      frameLoaderId: "L",
      frameUrl: `${FRAME}/page`,
      parentOrigin: "https://parent.test",
      cookieSiteOrigin,
    },
  );
  expect(r.ok).toBe(true);
  const names = (seen[0]?.headers.get("cookie") ?? "")
    .split(";")
    .map((c) => c.trim().split("=")[0])
    .filter(Boolean)
    .sort();
  return { names, spawnedSite: spawned[0]?.cookieSiteOrigin };
}

describe("an out-of-process frame's SameSite context", () => {
  it("sends only SameSite=None cookies under a cross-site top level", async () => {
    expect(await frameDocumentCookies("https://top.test")).toEqual({
      names: ["none"],
      spawnedSite: "",
    });
  });

  it("sends every cookie under a same-site top level", async () => {
    expect(await frameDocumentCookies("https://www.frame.test")).toEqual({
      names: ["dflt", "lax", "none", "strict"],
      spawnedSite: "https://www.frame.test",
    });
  });

  it("withholds same-site cookies across schemes on an iframe document", async () => {
    expect(await frameDocumentCookies("http://www.frame.test")).toEqual({
      names: ["none"],
      spawnedSite: "",
    });
  });

  it("keeps the top site's SameSite=Strict and Lax cookies off a cross-site frame's requests", async () => {
    await frameDocumentCookies("https://top.test");
    const jar = createCookieJar();
    for (const [name, attrs] of [
      ["strict", "; SameSite=Strict"],
      ["lax", "; SameSite=Lax"],
      ["none", "; SameSite=None"],
    ]) {
      jar.setFromHeader("https://top.test/login", `${name}=1; Secure; Path=/${attrs}`);
    }
    registerCookieJar(CONN, jar);
    const seen: Request[] = [];
    const frameOutbound = createSandboxOutboundOverride(
      {} as SandboxOutboundExports,
      {} as SandboxOutboundEnv,
      {
        fetch: async (req: Request) => {
          seen.push(req);
          return new Response("");
        },
      },
    ).parent({
      pageOrigin: FRAME,
      cookieSiteOrigin: String(spawned[0]?.cookieSiteOrigin),
      cookieKey: CONN,
    });
    await frameOutbound.fetch(
      new Request("https://top.test/api", {
        headers: { "x-kitesurf-allow-cross-origin": "1", "x-kitesurf-resource-type": "Image" },
      }),
    );
    expect(seen[0]?.headers.get("cookie")).toBe("none=1");
  });
});

describe("frameDocumentCookieSite", () => {
  it.each([
    ["https://top.test", "https://frame.test/", ""],
    ["https://top.test", "https://a.top.test/x", "https://top.test"],
    ["https://top.test", "https://a.top.test:8443/x", "https://top.test"],
    ["https://top.test", "http://www.top.test/x", ""],
    ["data:text/html,top", "https://top.test/", ""],
    ["https://top.test", "about:srcdoc", ""],
    ["", "https://top.test/", ""],
  ])("under the request site %j, a document at %j has the site %j", (site, url, expected) => {
    expect(frameDocumentCookieSite(site, url)).toBe(expected);
  });

  it("leaves an absent request site to the outbound's own default", () => {
    expect(frameDocumentCookieSite(undefined, "https://frame.test/")).toBeUndefined();
  });
});

describe("frameCookieSiteOrigin", () => {
  function frames(topUrl: string, chain: string[]) {
    const all = new Map<string, FrameState>([
      ["M", makeMainFrameState({ frameId: "M", loaderId: "L", url: topUrl })],
    ]);
    let parent = "M";
    for (const [i, url] of chain.entries()) {
      const id = `F${i}`;
      all.set(
        id,
        makeChildFrameState({
          frameId: id,
          parentFrameId: parent,
          loaderId: "L",
          url,
          name: "",
          ownerElementId: "",
          ownerBackendNodeId: i + 1,
          isCrossOrigin: true,
          delaysLoadEvent: false,
        }),
      );
      parent = id;
    }
    const target = { frameId: "M", url: topUrl, frames: all } as TargetState;
    return frameCookieSiteOrigin(target, all.get(parent)!);
  }

  it.each([
    ["https://top.test/", ["https://frame.test/"], "https://top.test"],
    ["https://top.test/", ["https://a.top.test/", "https://frame.test/"], "https://top.test"],
    ["https://top.test/", ["https://a.top.test:8443/", "https://frame.test/"], "https://top.test"],
    ["https://top.test/", ["http://www.top.test/", "https://frame.test/"], ""],
    ["https://top.test/", ["https://other.test/", "https://top.test/x"], ""],
    ["https://top.test/", ["about:srcdoc", "https://frame.test/"], "https://top.test"],
    ["https://top.test/", ["about:blank", "https://frame.test/"], "https://top.test"],
    ["data:text/html,top", ["https://frame.test/"], ""],
  ])("under %s, a frame below %j has the site %j", (top, chain, site) => {
    expect(frames(top, chain)).toBe(site);
  });
});
