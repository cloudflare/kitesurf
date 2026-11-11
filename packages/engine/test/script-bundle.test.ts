// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { buildScriptBundle, insertedSourceDigests } from "../src/eval/script-bundle.ts";
import type { ParentScriptDescriptor } from "../src/wasm.ts";

function classic(body: string, opts: Partial<ParentScriptDescriptor> = {}): ParentScriptDescriptor {
  return {
    src: null,
    kind: "classic",
    defer: false,
    async: false,
    body,
    ...opts,
  };
}

function module_(body: string, opts: Partial<ParentScriptDescriptor> = {}): ParentScriptDescriptor {
  return {
    src: null,
    kind: "module",
    defer: false,
    async: false,
    body,
    ...opts,
  };
}

describe("buildScriptBundle.classicRegularSource", () => {
  it("concatenates inline classic bodies into a single CJS run() wrapper", () => {
    const bundle = buildScriptBundle([
      classic('globalThis.__log.push("classic-1");'),
      classic('globalThis.__log.push("classic-2");'),
    ]);

    expect(bundle.classicRegularSource).not.toBeNull();
    const src = bundle.classicRegularSource!;
    expect(src).toContain("module.exports.run = async function");
    expect(src).toContain('globalThis.__log.push("classic-1");');
    expect(src).toContain('globalThis.__log.push("classic-2");');

    expect(src.indexOf('"classic-1"')).toBeLessThan(src.indexOf('"classic-2"'));
  });

  it("routes classic-async-external into the async bucket, not regular", () => {
    const bundle = buildScriptBundle([
      classic("globalThis.didRegular = true;"),
      classic("", {
        src: "/a.js",
        async: true,
        prefetchedSource: "globalThis.didAsync = true;",
      }),
    ]);

    expect(bundle.classicRegularSource).toContain("globalThis.didRegular = true;");
    expect(bundle.classicRegularSource).not.toContain("globalThis.didAsync");

    expect(bundle.classicAsyncSource).not.toBeNull();
    expect(bundle.classicAsyncSource!).toContain("globalThis.didAsync = true;");
  });

  it("returns null sources when there are no scripts", () => {
    const bundle = buildScriptBundle([]);
    expect(bundle.classicRegularSource).toBeNull();
    expect(bundle.classicAsyncSource).toBeNull();
    expect(bundle.moduleScriptUrls).toEqual([]);
    expect(bundle.additionalModules).toEqual({});
  });

  it("maps classic source after the generated var prelude", () => {
    const marker = "globalThis.__sourceMapMarker = sample;";
    const bundle = buildScriptBundle([classic(`var sample = 1;\n${marker}`)]);
    const source = bundle.classicRegularSource!;
    const markerOffset = source.lastIndexOf(marker);
    expect(markerOffset).toBeGreaterThanOrEqual(0);
    const sourceLine = source.slice(0, markerOffset).split("\n").length - 1;
    const sourceMapURL = bundle.classicRegularSourceMapURL;
    if (!sourceMapURL) throw new Error("expected the classic source map");
    const encoded = sourceMapURL.slice(sourceMapURL.indexOf(",") + 1);
    const { mappings } = JSON.parse(atob(encoded)) as { mappings: string };
    expect(mappings.split(";")[sourceLine]).toBe("AACA");
  });
});

describe("buildScriptBundle classic source map bound", () => {
  const marker = "globalThis.__sourceMapMarker = sample;";
  const asyncScript = (source: string): ParentScriptDescriptor =>
    classic("", { src: "/a.js", async: true, prefetchedSource: source });

  it("still maps a short async external script", () => {
    const bundle = buildScriptBundle([asyncScript(`var sample = 1;\n${marker}`)]);
    const source = bundle.classicAsyncSource!;
    const sourceLine = source.slice(0, source.lastIndexOf(marker)).split("\n").length - 1;
    const sourceMapURL = bundle.classicAsyncSourceMapURL!;
    const encoded = sourceMapURL.slice(sourceMapURL.indexOf(",") + 1);
    const { mappings } = JSON.parse(atob(encoded)) as { mappings: string };
    expect(mappings.split(";")[sourceLine]).toBe("AACA");
  });

  it("omits an oversized source map but keeps the scripts and their sourceURLs", () => {
    const body = `${"\n".repeat(1_000_000)}globalThis.__oversizedRan = true;`;
    const bundle = buildScriptBundle([classic(body), asyncScript(body)]);
    const check = (source: string | null, url: string): void => {
      expect(source?.includes("globalThis.__oversizedRan = true;")).toBe(true);
      expect(source?.slice(-120)).toContain(`//# sourceURL=${url}`);
      expect(source?.includes("sourceMappingURL")).toBe(false);
    };
    check(bundle.classicRegularSource, "/__ks_user_classic_regular.js");
    check(bundle.classicAsyncSource, "/__ks_user_classic_async.js");
    expect(bundle.classicRegularSourceMapURL).toBe("");
    expect(bundle.classicAsyncSourceMapURL).toBe("");
  }, 30_000);
});

describe("buildScriptBundle parser-inserted script lifecycle", () => {
  const LIFECYCLE = "__ks_state_local.parserScriptLifecycle(";

  it("fires load after an external script's body and the currentScript reset", () => {
    const bundle = buildScriptBundle([
      classic("", {
        src: "/a.js",
        resolvedSrc: "https://example.com/a.js",
        prefetchedSource: "globalThis.ranA = true;",
        scriptDomIndex: 3,
      }),
    ]);
    const src = bundle.classicRegularSource!;
    const call = `${LIFECYCLE}3, "/a.js", "https://example.com/a.js", true)`;
    expect(src).toContain(call);
    expect(src.indexOf("globalThis.ranA = true;")).toBeLessThan(src.indexOf(call));
    expect(src.indexOf("endClassicScript()")).toBeLessThan(src.indexOf(call));
  });

  it("fires load in the defer and async buckets, and for an empty external body", () => {
    const bundle = buildScriptBundle([
      classic("", { src: "/d.js", defer: true, prefetchedSource: "1;", scriptDomIndex: 0 }),
      classic("", { src: "/e.js", prefetchedSource: "", scriptDomIndex: 1 }),
      classic("", { src: "/s.js", async: true, prefetchedSource: "2;", scriptDomIndex: 2 }),
    ]);
    expect(bundle.classicRegularSource).toContain(`${LIFECYCLE}0, "/d.js", "/d.js", true)`);
    expect(bundle.classicRegularSource).toContain(`${LIFECYCLE}1, "/e.js", "/e.js", true)`);
    expect(bundle.classicAsyncSource).toContain(`${LIFECYCLE}2, "/s.js", "/s.js", true)`);
  });

  it("fires error for a blocked or failed external script", () => {
    const bundle = buildScriptBundle([
      classic("", {
        src: "/blocked.js",
        blocked: { reason: "sri", message: "integrity mismatch" },
        scriptDomIndex: 0,
      }),
      classic("", { src: "/gone.js", prefetchError: "HTTP 404", scriptDomIndex: 1 }),
    ]);
    const src = bundle.classicRegularSource!;
    expect(src).toContain("integrity mismatch");
    expect(src).toContain(`${LIFECYCLE}0, "/blocked.js", "/blocked.js", false)`);
    expect(src).toContain(`${LIFECYCLE}1, "/gone.js", "/gone.js", false)`);
    expect(src).not.toContain(", true)");
  });

  it("fires nothing for inline scripts or inserted bakes", () => {
    const bundle = buildScriptBundle(
      [
        classic("globalThis.inline = 1;", { scriptDomIndex: 0 }),
        classic("globalThis.blockedInline = 1;", {
          blocked: { reason: "csp", message: "inline blocked" },
        }),
      ],
      {
        insertedBake: [classic("", { src: "/i.js", prefetchedSource: "globalThis.i = 1;" })],
        insertedDigests: new Map([["/i.js", "digest"]]),
      },
    );
    expect(bundle.classicRegularSource).toContain("globalThis.inline = 1;");
    expect(bundle.classicRegularSource).not.toContain(LIFECYCLE);
    const inserted = Object.values(bundle.insertedModules);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).not.toContain(LIFECYCLE);
  });
});

describe("buildScriptBundle.moduleScriptUrls + additionalModules", () => {
  it("preserves module entries in document order and bakes bodies by URL", () => {
    const bundle = buildScriptBundle([
      module_("globalThis.mod = 'a';"),
      classic("var spacer = 1;"),
      module_("globalThis.mod = 'b';"),
    ]);
    expect(bundle.moduleScriptUrls).toHaveLength(2);
    expect(bundle.moduleScriptUrls[0]).not.toBe(bundle.moduleScriptUrls[1]);
    expect(bundle.additionalModules[bundle.moduleScriptUrls[0]!]).toBe("globalThis.mod = 'a';");
    expect(bundle.additionalModules[bundle.moduleScriptUrls[1]!]).toBe("globalThis.mod = 'b';");
  });

  it("uses walker-supplied URLs + bodies when additionalModules is provided", () => {
    const url1 = "https://example.com/a.js";
    const url2 = "https://example.com/b.js";
    const bundle = buildScriptBundle(
      [
        module_("// inline body, ignored when resolvedSrc is set", {
          src: "/a.js",
          resolvedSrc: url1,
          prefetchedSource: "X",
        }),
        module_("// inline body, ignored when resolvedSrc is set", {
          src: "/b.js",
          resolvedSrc: url2,
          prefetchedSource: "Y",
        }),
      ],
      {
        additionalModules: {
          [url1]: "globalThis.a = 1;",
          [url2]: "globalThis.b = 2;",
          "https://example.com/helper.js": "export const v = 42;",
        },
      },
    );
    expect(bundle.moduleScriptUrls).toEqual([url1, url2]);
    expect(bundle.additionalModules[url1]).toBe("globalThis.a = 1;");
    expect(bundle.additionalModules[url2]).toBe("globalThis.b = 2;");
    expect(bundle.additionalModules["https://example.com/helper.js"]).toBe("export const v = 42;");
  });

  it("skips empty module bodies but keeps prefetch-error stubs", () => {
    const bundle = buildScriptBundle([
      module_("", { src: "/empty.js", prefetchedSource: "" }),
      module_("", {
        src: "/broken.js",
        prefetchError: "HTTP 500",
      }),
    ]);
    expect(bundle.moduleScriptUrls).toHaveLength(1);
    const errUrl = bundle.moduleScriptUrls[0]!;
    expect(errUrl).toMatch(/kitesurf-error\.invalid/);
    const body = bundle.additionalModules[errUrl]!;
    expect(body).toContain("module prefetch failed");
    expect(body).toContain("/broken.js");
  });
});

describe("script URLs in generated comments", () => {
  const payload = "globalThis.injected = 1;//";
  const spellings = ["\n", "\r", "\u2028", "\u2029"].map(
    (terminator) => `https://cdn.test/a.js${terminator}${payload}`,
  );
  const body = "var a = 1;\nlet b = 2;\nglobalThis.ran = a + b;";
  // String literals may hold U+2028 and U+2029, so quoted copies of the src are not code.
  const linesStartingWithPayload = (source: string, src: string): string[] =>
    source
      .replaceAll(JSON.stringify(src), '""')
      .split(/\r\n|[\n\r\u2028\u2029]/)
      .filter((line) => line.trimStart().startsWith(payload));

  it.each(spellings)("keeps a parser-inserted script's src inside its comments (%j)", (src) => {
    const bundle = buildScriptBundle([classic("", { src, prefetchedSource: body })]);
    const source = bundle.classicRegularSource!;
    expect(source).toContain("globalThis.ran = a + b;");
    expect(linesStartingWithPayload(source, src)).toEqual([]);
  });

  it.each(spellings)("keeps an inserted bake's src inside its comments (%j)", async (src) => {
    const insertedBake = [classic("", { src, resolvedSrc: src, prefetchedSource: body })];
    const insertedDigests = await insertedSourceDigests(insertedBake);
    const bundle = buildScriptBundle([], { insertedBake, insertedDigests });
    expect(bundle.insertedManifest).toHaveLength(1);
    const source = bundle.insertedModules[bundle.insertedManifest[0]!.module]!;
    expect(source).toContain("globalThis.ran = a + b;");
    expect(source).toContain("//# sourceURL=https://cdn.test/a.js");
    expect(linesStartingWithPayload(source, src)).toEqual([]);
  });
});
