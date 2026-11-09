// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import {
  assignModuleRegistryNames,
  astroIslandModuleUrls,
  chunkBaseName,
  documentTokens,
  extractClassicDynamicSeeds,
  importMapModuleSource,
  mergeImportMap,
  modulePreloadSeeds,
  parseImportMap,
  parseImportMaps,
  resolvedModuleRecord,
  resolveImportMapSpecifier,
  rewriteImportMetaResolve,
  walkModuleGraph,
  type ParsedImportMap,
} from "../src/eval/walk-module-graph.ts";
import type { SandboxOutboundOverride } from "../src/eval/outbound.ts";
import type { ParentScriptDescriptor } from "../src/wasm.ts";

const BASE = "https://example.com/js/app.min.js";

describe("astroIslandModuleUrls", () => {
  it("collects component and renderer urls from every island once", () => {
    const html =
      '<astro-island uid="a" component-url="/_astro/a.js?v=1&amp;x=2" renderer-url="/_astro/client.js">' +
      '</astro-island><astro-island component-url="https://cdn.example/b.js" renderer-url="/_astro/client.js">' +
      '</astro-island><div component-url="/_astro/not-an-island.js"></div>';
    expect(astroIslandModuleUrls(html, "https://site.example/page")).toEqual([
      "https://site.example/_astro/a.js?v=1&x=2",
      "https://site.example/_astro/client.js",
      "https://cdn.example/b.js",
    ]);
  });
});

describe("extractClassicDynamicSeeds", () => {
  it("seeds and absolutizes relative literal imports", () => {
    const { rewritten, seeds } = extractClassicDynamicSeeds(`import("./chunk.js").then(go);`, BASE);
    expect(seeds).toEqual(["https://example.com/js/chunk.js"]);
    expect(rewritten).toContain(`import("https://example.com/js/chunk.js")`);
  });

  it("does NOT seed bare specifiers and defers them to __ks_import", () => {
    const { rewritten, seeds } = extractClassicDynamicSeeds(
      `import("@wordpress/vips/worker").then(go);`,
      BASE,
    );
    expect(seeds).toEqual([]);
    expect(rewritten).toContain(`__ks_import("@wordpress/vips/worker", ${JSON.stringify(BASE)})`);
    expect(rewritten).not.toMatch(/(?<!__ks_)import\("@wordpress/);
  });

  it("treats backtick bare specifiers the same", () => {
    const { rewritten, seeds } = extractClassicDynamicSeeds("import(`lodash-es`).then(go);", BASE);
    expect(seeds).toEqual([]);
    expect(rewritten).toContain(`__ks_import("lodash-es"`);
  });

  it("seeds root-absolute and leaves data: untouched", () => {
    const root = extractClassicDynamicSeeds(`import("/assets/x.js")`, BASE);
    expect(root.seeds).toEqual(["https://example.com/assets/x.js"]);
    const data = extractClassicDynamicSeeds(`import("data:text/javascript,export{}")`, BASE);
    expect(data.seeds).toEqual([]);
    expect(data.rewritten).toBe(`import("data:text/javascript,export{}")`);
  });

  it("routes computed import(expr) to __ks_import", () => {
    const { rewritten, seeds } = extractClassicDynamicSeeds(`import(name + ".js");`, BASE);
    expect(seeds).toEqual([]);
    expect(rewritten).toContain(`__ks_import(name + ".js", ${JSON.stringify(BASE)})`);
  });

  it("keeps the options argument when absolutizing a literal", () => {
    const { rewritten, seeds } = extractClassicDynamicSeeds(
      `import("./cfg.json", { with: { type: "json" } })`,
      BASE,
    );
    expect(seeds).toEqual(["https://example.com/js/cfg.json"]);
    expect(rewritten).toBe(`import("https://example.com/js/cfg.json", { with: { type: "json" } })`);
  });

  it("passes only the specifier expression of a computed import to __ks_import", () => {
    const { rewritten } = extractClassicDynamicSeeds(
      'import(`./${name}.json`, { with: { type: "json" } })',
      BASE,
    );
    expect(rewritten).toBe("__ks_import(`./${name}.json`, " + JSON.stringify(BASE) + ")");
  });
});

describe("extractClassicDynamicSeeds when the lexer misreads a script", () => {
  const nativeCalls = (source: string) => source.match(/(?<![\w$])import\s*(?:\/\*.*?\*\/\s*)*\(/g);

  it.each([
    ["the lexer throws", `{}\n/}/.test(""); import("./internal-state.js").then(go);`],
    ["the lexer skips code", `with ({}) /a\\//.test(""); import("./internal-state.js");`],
    ["a call is spread", `{}\n/}/.test(""); [...import("./x.js").then(go)];`],
    ["a number ends the line before a call", `const n = 1.\nimport("./x.js");`],
  ])("sends every import() to the runtime loader when %s", (_, body) => {
    expect(() => new Function(body)).not.toThrow();
    const { rewritten, seeds } = extractClassicDynamicSeeds(body, BASE);
    expect(seeds).toEqual([]);
    expect(nativeCalls(rewritten)).toBeNull();
    expect(rewritten).toContain("__ks_import");
  });

  it("absolutizes an import() with a comment before the paren", () => {
    const { rewritten, seeds } = extractClassicDynamicSeeds(`import/**/("./x.js");`, BASE);
    expect(seeds).toEqual(["https://example.com/js/x.js"]);
    expect(rewritten).toBe(`import/**/("https://example.com/js/x.js");`);
  });

  it("rewrites an import() on the line after a comment that ends with a dot", () => {
    const { rewritten, seeds } = extractClassicDynamicSeeds(
      `// Load the chunk.\nimport("./x.js");`,
      BASE,
    );
    expect(seeds).toEqual(["https://example.com/js/x.js"]);
    expect(rewritten).toBe(`// Load the chunk.\nimport("https://example.com/js/x.js");`);
  });

  it.each([
    ["alone", `const a = { import: (x) => x };\nglobalThis.out = a.\nimport(1);`],
    [
      "next to a call the lexer skips",
      `const a = { import: (x) => x };\nglobalThis.out = a?.\n  import(1);\nwith ({}) /a\\//.test(""); import("./x.js");`,
    ],
  ])("keeps a member call whose dot ends the previous line %s", (_, body) => {
    const { rewritten } = extractClassicDynamicSeeds(body, BASE);
    expect(rewritten).toMatch(/\.\n\s*import\(1\)/);
    const out: { out?: unknown } = {};
    new Function("globalThis", "__ks_import", rewritten)(out, () => {});
    expect(out.out).toBe(1);
  });

  it("does not rewrite member calls or names that end in import", () => {
    const body = `{}\n/}/.test(""); a.import(1); a?.import(2); reimport(3); import("./x.js");`;
    const { rewritten } = extractClassicDynamicSeeds(body, BASE);
    expect(rewritten).toMatch(
      /^\{\}\n\/\}\/\.test\(""\); a\.import\(1\); a\?\.import\(2\); reimport\(3\); __ks_import_\w+\("\.\/x\.js"\);\n/,
    );
  });

  // Runs rewritten classic scripts in one scope, as the bundle does, and records the loader calls.
  function runClassic(...scripts: string[]): unknown[][] {
    const calls: unknown[][] = [];
    new Function("__ks_import", scripts.join("\n"))((...args: unknown[]) => calls.push(args));
    return calls;
  }

  it("resolves the runtime imports against each script, not the document", () => {
    const other = "https://cdn.example/lib/b.js";
    const a = extractClassicDynamicSeeds(
      `{}\n/}/.test(""); import("./chunk.js", { with: { type: "json" } });`,
      BASE,
    );
    const b = extractClassicDynamicSeeds(`{}\n/}/.test(""); import("./c.js");`, other);
    expect(runClassic(a.rewritten, b.rewritten)).toEqual([
      ["./chunk.js", BASE],
      ["./c.js", other],
    ]);
  });

  it.each([
    ["a comment", `// lazy: import("./a.js")\nimport("./b.js");`],
    ["a string", `const s = "import('./a.js')"; import("./b.js");`],
  ])("still seeds the lexed calls when %s mentions import(", (_, body) => {
    const { rewritten, seeds } = extractClassicDynamicSeeds(body, BASE);
    expect(seeds).toEqual(["https://example.com/js/b.js"]);
    expect(rewritten).toContain(`import("https://example.com/js/b.js")`);
  });

  it("sends only the calls the lexer skipped to the runtime loader", () => {
    const body = `import("./a.js");\nwith ({}) /a\\//.test(""); import("./b.js");`;
    expect(() => new Function(body)).not.toThrow();
    const { rewritten, seeds } = extractClassicDynamicSeeds(body, BASE);
    expect(seeds).toEqual(["https://example.com/js/a.js"]);
    expect(nativeCalls(rewritten)).toEqual([`import(`]);
    expect(rewritten).toContain(`import("https://example.com/js/a.js")`);
    expect(runClassic(rewritten.replace(/import\("[^"]*"\);/, ""))).toEqual([["./b.js", BASE]]);
  });

  it("keeps a method named import valid", () => {
    const { rewritten } = extractClassicDynamicSeeds(
      `{}\n/}/.test(""); const o = { import(x) { return x; } }; import("./x.js");`,
      BASE,
    );
    expect(runClassic(rewritten)).toEqual([["./x.js", BASE]]);
  });

  it.each([
    ["line comments", `const s = "import${"//".repeat(2000)}x";`],
    ["block comments", `const s = "import${"/**/".repeat(2000)}x";`],
    ["nested block comments", `const s = "import${"/*a/*b*/c*/".repeat(1000)}";`],
  ])("scans a run of %s that no call follows in linear time", (_, body) => {
    const start = performance.now();
    expect(extractClassicDynamicSeeds(body, BASE)).toEqual({ rewritten: body, seeds: [] });
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("leaves a script without import() calls alone", () => {
    const body = `{}\n/}/.test(""); const s = "imports";`;
    expect(extractClassicDynamicSeeds(body, BASE)).toEqual({ rewritten: body, seeds: [] });
  });
});

function stubOutbound(
  bodies: Record<string, string> = {},
  delays: Record<string, number> = {},
): SandboxOutboundOverride {
  const fetcher = {
    fetch: async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (delays[url]) await new Promise((r) => setTimeout(r, delays[url]));
      return new Response(bodies[url] ?? "export default 1;", {
        headers: { "content-type": "text/javascript" },
      });
    },
  } as Fetcher;
  return {
    external: false,
    parent: () => fetcher,
    loaded: () => fetcher,
    session: () => (request) => fetcher.fetch(request.url),
    final: async () => new Response(null, { status: 404 }),
  };
}

function classicExternal(src: string, prefetchedSource: string): ParentScriptDescriptor {
  return { src, kind: "classic", defer: false, async: false, body: "", prefetchedSource };
}

function moduleInline(body: string): ParentScriptDescriptor {
  return { src: null, kind: "module", defer: false, async: false, body };
}

describe("walkModuleGraph query-collision alias in classic bodies", () => {
  const PAGE = "https://example.com/page.html";
  const walk = (descriptors: ParentScriptDescriptor[]) =>
    walkModuleGraph({
      descriptors,
      pageUrl: PAGE,
      connectionId: "conn",
      mainFrameId: "",
      mainLoaderId: "",
      extraHeaders: {},
      cookieKey: "",
      options: {},
      sandboxOutbound: stubOutbound(),
    });

  it("re-points an external classic script whose src is relative", async () => {
    const { descriptors, additionalModules } = await walk([
      moduleInline(`import "/x.js?v=1";`),
      moduleInline(`import "/x.js?v=2";`),
      classicExternal("/static/app.js", `import("/x.js?v=1").then(go);`),
    ]);
    const aliases = Object.keys(additionalModules).filter((k) => k.includes("__ks_query_"));
    expect(aliases).toHaveLength(2);
    expect(additionalModules["https://example.com/x.js"]).toBeUndefined();

    const classic = descriptors.find((d) => d.kind === "classic");
    expect(classic?.prefetchedSource).toMatch(
      /import\("https:\/\/example\.com\/x\.__ks_query_\d+\.js"\)\.then\(go\);/,
    );
    expect(classic?.prefetchedSource).not.toContain("x.js?v=1");
  });
});

describe("page specifiers that name the loaded worker's own modules", () => {
  const PAGE = "https://example.com/page.html";
  const walk = (descriptors: ParentScriptDescriptor[], baseUrl?: string) =>
    walkModuleGraph({
      descriptors,
      pageUrl: PAGE,
      connectionId: "conn",
      options: baseUrl ? { baseUrl } : {},
      sandboxOutbound: stubOutbound(),
    });

  it.each(["file:///bundle/internal-state.js", "cloudflare:workers", "node:fs"])(
    "fails an inline module that statically imports %s",
    async (specifier) => {
      const { descriptors, additionalModules } = await walk([
        moduleInline(`import * as ns from ${JSON.stringify(specifier)}; globalThis.ns = ns;`),
      ]);
      expect(descriptors[0]?.prefetchError).toMatch(/is not an http\(s\) module URL/);
      expect(Object.keys(additionalModules)).toEqual([]);
    },
  );

  it("fails a fetched module that statically imports a private module", async () => {
    const { descriptors, additionalModules } = await walk([moduleInline(`import "./dep.js";`)]);
    expect(descriptors[0]?.prefetchError).toBeUndefined();
    expect(Object.keys(additionalModules)).toContain("https://example.com/dep.js");
    const hostile = await walkModuleGraph({
      descriptors: [moduleInline(`import "./dep.js";`)],
      pageUrl: PAGE,
      connectionId: "conn",
      sandboxOutbound: stubOutbound({
        "https://example.com/dep.js": `import "file:///bundle/internal-state.js";`,
      }),
    });
    expect(Object.keys(hostile.additionalModules)).not.toContain("https://example.com/dep.js");
  });

  it("routes a dynamic import of a private module to the runtime loader", async () => {
    const { descriptors, additionalModules } = await walk([
      moduleInline(`import("file:///bundle/internal-state.js");`),
      {
        src: null,
        kind: "classic",
        defer: false,
        async: false,
        body: `import("file:///bundle/internal-state.js");`,
      },
    ]);
    const [inline] = Object.values(additionalModules);
    expect(inline).toContain(`__ks_import("file:///bundle/internal-state.js"`);
    expect(descriptors[1]?.body).toBe(
      `__ks_import("file:///bundle/internal-state.js", ${JSON.stringify(PAGE)});`,
    );
  });

  it("keys inline modules under an http(s) url whatever the base url", async () => {
    const { descriptors, additionalModules } = await walk(
      [moduleInline(`import "./internal-state.js";`)],
      "file:///bundle/",
    );
    expect(Object.keys(additionalModules).every((k) => k.startsWith("https://"))).toBe(true);
    expect(descriptors[0]?.resolvedSrc).toMatch(/^https:\/\//);
  });

  it("does not resolve a registry name outside http(s) at run time", () => {
    const source = importMapModuleSource(
      { imports: new Map(), scopes: new Map() },
      new Map([["https://example.com/evil.js", "file:///bundle/internal-state.js"]]),
    );
    const { resolveModuleRegistryUrl } = new Function(
      `${source.replaceAll("export function", "function")}\nreturn { resolveModuleRegistryUrl };`,
    )() as { resolveModuleRegistryUrl(url: string): string };
    for (const url of [
      "internal-state.js",
      "./internal-state.js",
      "file:///bundle/internal-state.js",
      "cloudflare:workers",
      "https://example.com/evil.js",
    ]) {
      expect(() => resolveModuleRegistryUrl(url), url).toThrow(TypeError);
    }
    expect(resolveModuleRegistryUrl("https://example.com/app.js")).toBe(
      "https://example.com/app.js",
    );
  });
});

describe("walkModuleGraph asset-import stubs", () => {
  it("keeps the imported url out of the stub body", async () => {
    const url = "https://example.com/a.css?*/globalThis.ran=1;/*";
    const { additionalModules } = await walkModuleGraph({
      descriptors: [moduleInline(`import ${JSON.stringify(url)};`)],
      pageUrl: "https://example.com/page.html",
      connectionId: "conn",
      sandboxOutbound: stubOutbound(),
    });
    const stub = String(
      Object.values(additionalModules).find(
        (body) => typeof body === "string" && body.includes("asset-import"),
      ),
    );
    // A registry-renamed module also gets a synthetic import.meta that holds the url as a string.
    expect(stub.endsWith("/* kitesurf: asset-import side-effect stub */\nexport {};\n")).toBe(true);
    expect(stub.split(JSON.stringify(url)).join("")).not.toContain("globalThis.ran");
  });
});

describe("modulePreloadSeeds", () => {
  it("collects script-destination modulepreload links once, with their nonce and integrity", () => {
    const html =
      '<link rel="modulepreload" href="/a.js?x=1&amp;y=2" nonce="n1">' +
      "<link rel='preload modulepreload' href='b.js'>" +
      '<link rel=modulepreload href="/a.js?x=1&amp;y=2">' +
      '<link rel="modulepreload" as="script" href="https://cdn.example/c.js">' +
      '<link rel="modulepreload" as="style" href="/style.css">' +
      '<link rel="modulepreload" href="/sri.js" integrity="sha384-x">' +
      '<link rel="modulepreload" href="data:text/javascript,export{}">' +
      '<link rel="preload" as="script" href="/classic.js">';
    expect(modulePreloadSeeds(html, "https://site.example/dir/page")).toEqual([
      { url: "https://site.example/a.js?x=1&y=2", nonce: "n1", integrity: null },
      { url: "https://site.example/dir/b.js", nonce: null, integrity: null },
      { url: "https://cdn.example/c.js", nonce: null, integrity: null },
      { url: "https://site.example/sri.js", nonce: null, integrity: "sha384-x" },
    ]);
  });
});

describe("walkModuleGraph modulepreload seeds", () => {
  const PAGE = "https://example.com/page.html";
  const DEP = "https://example.com/dep.js";

  it("checks a module against its modulepreload integrity when another module imports it", async () => {
    const pinned = "export const dep = 1;";
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-384", new TextEncoder().encode(pinned)),
    );
    const integrity = "sha384-" + btoa(String.fromCharCode(...digest));
    const walk = (served: string) =>
      walkModuleGraph({
        descriptors: [moduleInline(`import "/dep.js";`)],
        pageUrl: PAGE,
        connectionId: "conn",
        options: {
          preloadSeeds: modulePreloadSeeds(
            `<link rel="modulepreload" href="/dep.js" integrity="${integrity}">`,
            PAGE,
          ),
        },
        sandboxOutbound: stubOutbound({ [DEP]: served }),
      });
    expect(Object.keys((await walk(pinned)).additionalModules)).toContain(DEP);
    const tampered = await walk("globalThis.changed = 1; export const dep = 1;");
    expect(Object.keys(tampered.additionalModules)).not.toContain(DEP);
  });

  it("still bakes an imported module whose preload fetch failed", async () => {
    let depRequests = 0;
    const fetcher = {
      fetch: async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === DEP && depRequests++ === 0) return new Response("no", { status: 404 });
        return new Response(url === DEP ? "export default 1;" : `import "/dep.js";`, {
          headers: { "content-type": "text/javascript" },
        });
      },
    } as Fetcher;
    const { additionalModules } = await walkModuleGraph({
      descriptors: [{ src: "/entry.js", kind: "module", defer: false, async: false, body: "" }],
      pageUrl: PAGE,
      connectionId: "conn",
      mainFrameId: "",
      mainLoaderId: "",
      extraHeaders: {},
      cookieKey: "",
      options: { preloadSeeds: [{ url: DEP, nonce: null, integrity: null }] },
      sandboxOutbound: {
        external: false,
        parent: () => fetcher,
        loaded: () => fetcher,
        session: () => (request) => fetcher.fetch(request.url),
        final: async () => new Response(null, { status: 404 }),
      },
    });
    expect(depRequests).toBe(2);
    expect(additionalModules[DEP]).toBe("export default 1;");
  });
});

describe("walkModuleGraph oversized dynamic modules", () => {
  const PAGE = "https://example.com/page.html";
  const huge = `export default ${JSON.stringify("x".repeat(5 * 1024 * 1024))};`;
  const walk = (descriptors: ParentScriptDescriptor[]) =>
    walkModuleGraph({
      descriptors,
      pageUrl: PAGE,
      connectionId: "conn",
      mainFrameId: "",
      mainLoaderId: "",
      extraHeaders: {},
      cookieKey: "",
      options: {},
      sandboxOutbound: stubOutbound({ "https://example.com/huge.js": huge }),
    });

  it("does not bake a dynamic-only module past the per-module ceiling", async () => {
    const { additionalModules } = await walk([
      moduleInline(`import("/huge.js").then(go); import "/small.js";`),
    ]);
    const baked = Object.keys(additionalModules);
    expect(baked).toContain("https://example.com/small.js");
    expect(baked).not.toContain("https://example.com/huge.js");
  });

  it("does not bake a classic script's oversized import() target", async () => {
    const { descriptors, additionalModules } = await walk([
      classicExternal("/static/app.js", `import("/huge.js").then(go);`),
    ]);
    expect(Object.keys(additionalModules)).not.toContain("https://example.com/huge.js");
    const classic = descriptors.find((d) => d.kind === "classic");
    expect(classic?.prefetchedSource).toBe(
      `__ks_import("https://example.com/huge.js", "https://example.com/static/app.js").then(go);`,
    );
  });

  it("still bakes the same module when it is imported statically", async () => {
    const { additionalModules } = await walk([moduleInline(`import "/huge.js";`)]);
    expect(Object.keys(additionalModules)).toContain("https://example.com/huge.js");
  });
});

describe("registry entries the document names", () => {
  it("strips vite and webpack content hashes from chunk names", () => {
    expect(chunkBaseName("https://h.test/build/ModelList-B41z-uz2.js")).toBe("ModelList");
    expect(chunkBaseName("https://h.test/build/index-client-BK7Bwd96.js")).toBe("index-client");
    expect(chunkBaseName("https://h.test/static/js/settings.3f2a9c1e.js")).toBe("settings");
    expect(chunkBaseName("https://h.test/js/chunk-vendors.js")).toBe("chunk-vendors");
    expect(chunkBaseName("https://h.test/js/a-1b2c3d4e.js")).toBeNull();
  });

  it("strips digit-less vite hashes and webpack's .chunk suffix, not words", () => {
    expect(chunkBaseName("https://h.test/build/ModelList-DzKqWvXa.js")).toBe("ModelList");
    expect(chunkBaseName("https://h.test/build/ModelList-Bxz_uzQa.js")).toBe("ModelList");
    expect(chunkBaseName("https://h.test/static/js/settings.3f2a9c1e.chunk.js")).toBe("settings");
    expect(chunkBaseName("https://h.test/js/header-dropdown.js")).toBe("header-dropdown");
    expect(chunkBaseName("https://h.test/js/ModelList-Settings.js")).toBe("ModelList-Settings");
  });

  it("tokenizes markup into whole case-sensitive names", () => {
    const tokens = documentTokens(`<div data-target="ModelList"></div><p>modellist rows</p>`);
    expect(tokens.has("ModelList")).toBe(true);
    expect(tokens.has("Model")).toBe(false);
  });

  it("does not tokenize a document past the size guard", () => {
    const big = `<div data-target="ModelList"></div>${" ".repeat(4 * 1024 * 1024)}`;
    expect(documentTokens(big).size).toBe(0);
  });

  it("bakes the named entry of a registry past the deadline", async () => {
    const PAGE = "https://h.test/models";
    const names = [
      "Admin",
      "Billing",
      "Charts",
      "Datasets",
      "Emojis",
      "Feeds",
      "Gallery",
      "Inbox",
      "Jobs",
      "ModelList",
    ];
    const registry = names
      .map((n, i) => `case "${n}": return import("./${n}-Ab12Cd3${i}.js");`)
      .join("\n");
    const out = stubOutbound(
      {
        "https://h.test/build/index.js": `export function load(n) { switch (n) {\n${registry}\n} }`,
      },
      { "https://h.test/build/index.js": 1_100 },
    );
    const { additionalModules } = await walkModuleGraph({
      descriptors: [classicExternal("/boot.js", `import("/build/index.js");`)],
      pageUrl: PAGE,
      connectionId: "conn",
      mainFrameId: "",
      mainLoaderId: "",
      extraHeaders: {},
      cookieKey: "",
      options: { documentHtml: `<section data-target="ModelList"></section>` },
      sandboxOutbound: out,
    });
    const baked = Object.keys(additionalModules).map((u) => u.split("/").pop());
    expect(baked).toContain("ModelList-Ab12Cd39.js");
    expect(baked.filter((f) => f !== "index.js" && f !== "ModelList-Ab12Cd39.js")).toEqual([]);
  });
});

describe("walkModuleGraph import maps in document order", () => {
  const PAGE = "https://example.com/page.html";
  const at = (d: ParentScriptDescriptor, scriptDomIndex: number) => ({ ...d, scriptDomIndex });
  const walk = (
    descriptors: ParentScriptDescriptor[],
    importMaps: { source: string; baseUrl: string; scriptDomIndex: number }[],
    bodies: Record<string, string> = {},
  ) =>
    walkModuleGraph({
      descriptors,
      pageUrl: PAGE,
      connectionId: "conn",
      mainFrameId: "",
      mainLoaderId: "",
      extraHeaders: {},
      cookieKey: "",
      options: { importMaps },
      sandboxOutbound: stubOutbound(bodies),
    });

  it("does not let a map below a script redirect what that script already resolved", async () => {
    const { descriptors, additionalModules, importMapModuleSource } = await walk(
      [
        at({ src: null, kind: "classic", defer: false, async: false, body: `import("/a.js");` }, 0),
        at(moduleInline(`import "/early.js";`), 2),
        at(moduleInline(`import "/a.js"; import "late"; import "/early.js";`), 4),
      ],
      [
        {
          source: JSON.stringify({ imports: { "/a.js": "/b.js", late: "/late.js" } }),
          baseUrl: PAGE,
          scriptDomIndex: 1,
        },
        {
          source: JSON.stringify({ imports: { "/early.js": "/redirected.js" } }),
          baseUrl: PAGE,
          scriptDomIndex: 3,
        },
      ],
    );
    const classic = descriptors.find((d) => d.kind === "classic");
    expect(classic?.body).toBe(`import("https://example.com/a.js");`);
    const baked = Object.keys(additionalModules);
    expect(baked).toContain("https://example.com/a.js");
    expect(baked).toContain("https://example.com/early.js");
    expect(baked).toContain("https://example.com/late.js");
    expect(baked).not.toContain("https://example.com/b.js");
    expect(baked).not.toContain("https://example.com/redirected.js");
    const later = additionalModules["https://example.com/__kitesurf_inline_1.js"];
    expect(later).toBe(`import "/a.js"; import "https://example.com/late.js"; import "/early.js";`);
    expect(importMapModuleSource).toContain(`["late","https://example.com/late.js"]`);
    expect(importMapModuleSource).not.toContain("b.js");
    expect(importMapModuleSource).not.toContain("redirected.js");
  });

  it("resolves an external module entry's imports against the final map", async () => {
    const { additionalModules } = await walk(
      [at({ src: "/entry.js", kind: "module", defer: false, async: false, body: "" }, 0)],
      [
        {
          source: JSON.stringify({ imports: { "/dep.js": "/dep-mapped.js" } }),
          baseUrl: PAGE,
          scriptDomIndex: 1,
        },
      ],
      { "https://example.com/entry.js": `import "/dep.js";` },
    );
    const baked = Object.keys(additionalModules);
    expect(baked).toContain("https://example.com/dep-mapped.js");
    expect(baked).not.toContain("https://example.com/dep.js");
    expect(additionalModules["https://example.com/entry.js"]).toBe(
      `import "https://example.com/dep-mapped.js";`,
    );
  });
});

describe("import maps", () => {
  const map = parseImportMaps(
    [
      JSON.stringify({
        imports: {
          react: "/vendor/react.js?dev",
          docs: "/docs/",
          "pkg/": "/vendor/pkg/",
        },
        scopes: {
          "/admin/": { react: "/vendor/react-admin.js" },
        },
      }),
    ],
    "https://example.com/app/",
  );

  it("resolves exact and prefix bare specifiers", () => {
    expect(resolveImportMapSpecifier("react", "https://example.com/app/main.js", map)).toBe(
      "https://example.com/vendor/react.js?dev",
    );
    expect(resolveImportMapSpecifier("docs", "https://example.com/app/main.js", map)).toBe(
      "https://example.com/docs/",
    );
    expect(resolveImportMapSpecifier("pkg/utils.js", "https://example.com/app/main.js", map)).toBe(
      "https://example.com/vendor/pkg/utils.js",
    );
  });

  it("prefers the longest matching scope", () => {
    expect(resolveImportMapSpecifier("react", "https://example.com/admin/main.js", map)).toBe(
      "https://example.com/vendor/react-admin.js",
    );
  });

  it("leaves unmapped bare specifiers unresolved", () => {
    expect(resolveImportMapSpecifier("missing", "https://example.com/app/main.js", map)).toBeNull();
  });

  it("blocks null mappings and prefix backtracking", () => {
    const blocked = parseImportMaps(
      [JSON.stringify({ imports: { blocked: null, "safe/": "/vendor/safe/" } })],
      "https://example.com/",
    );
    expect(resolveImportMapSpecifier("blocked", "https://example.com/main.js", blocked)).toBeNull();
    expect(
      resolveImportMapSpecifier("safe/../secret.js", "https://example.com/main.js", blocked),
    ).toBeNull();
  });

  it("nulls addresses that are neither absolute nor /, ./, ../ prefixed", () => {
    const parsed = parseImportMap(
      JSON.stringify({
        imports: {
          foo1: "bar",
          foo2: "\\bar",
          foo3: "~bar",
          foo4: "#bar",
          foo5: "?bar",
          dotSlash1: "%2E/",
          dotDotSlash1: "%2E%2E/",
          slash2: "%2F",
        },
      }),
      "https://base.example/path1/path2/path3",
    );
    expect(parsed).not.toBeNull();
    expect([...parsed!.imports.values()]).toEqual([null, null, null, null, null, null, null, null]);
  });

  it("keeps unparseable absolute URL specifier keys as bare keys", () => {
    const parsed = parseImportMap(
      JSON.stringify({
        imports: {
          "https://example.com:demo": "/unparseable2",
          "http://[www.example.com]/": "/unparseable3/",
        },
      }),
      "https://base.example/path1/path2/path3",
    );
    expect([...parsed!.imports]).toEqual([
      ["https://example.com:demo", "https://base.example/unparseable2"],
      ["http://[www.example.com]/", "https://base.example/unparseable3/"],
    ]);
  });

  it("resolves /, ./ and ../ addresses against the map's base and keeps absolute ones", () => {
    const parsed = parseImportMap(
      JSON.stringify({
        imports: {
          dotSlash: "./foo",
          dotDotSlash: "../foo",
          slash: "/foo",
          absolute: "https://cdn.example/x.js",
          scheme: "data:text/javascript,export default 1",
        },
      }),
      "https://base.example/path1/path2/path3",
    );
    expect([...parsed!.imports]).toEqual([
      ["dotSlash", "https://base.example/path1/path2/foo"],
      ["dotDotSlash", "https://base.example/path1/foo"],
      ["slash", "https://base.example/foo"],
      ["absolute", "https://cdn.example/x.js"],
      ["scheme", "data:text/javascript,export default 1"],
    ]);
  });

  it("rejects a map whose imports or scopes are not objects", () => {
    expect(parseImportMap(`{"imports": []}`, "https://example.com/")).toBeNull();
    expect(parseImportMap(`{"scopes": "x"}`, "https://example.com/")).toBeNull();
    expect(parseImportMap(`{"scopes": {"/a/": 1}}`, "https://example.com/")).toBeNull();
    expect(parseImportMap(`Parse Error`, "https://example.com/")).toBeNull();
    expect(parseImportMap(`{}`, "https://example.com/")).toEqual({
      imports: new Map(),
      scopes: new Map(),
    });
  });

  it("matches a scope exactly unless it ends with a slash", () => {
    const exact = parseImportMaps(
      [JSON.stringify({ scopes: { "/js": { moment: "/exact/moment" } } })],
      "https://example.com/app/index.html",
    );
    expect(resolveImportMapSpecifier("moment", "https://example.com/js", exact)).toBe(
      "https://example.com/exact/moment",
    );
    expect(resolveImportMapSpecifier("moment", "https://example.com/js/", exact)).toBeNull();
    expect(resolveImportMapSpecifier("moment", "https://example.com/js/app.mjs", exact)).toBeNull();
    expect(resolveImportMapSpecifier("moment", "https://example.com/jsiscool", exact)).toBeNull();
    const prefix = parseImportMaps(
      [JSON.stringify({ scopes: { "/js/": { moment: "/any/moment" } } })],
      "https://example.com/app/index.html",
    );
    expect(resolveImportMapSpecifier("moment", "https://example.com/js", prefix)).toBeNull();
    expect(resolveImportMapSpecifier("moment", "https://example.com/js/app.mjs", prefix)).toBe(
      "https://example.com/any/moment",
    );
  });

  it("drops incoming rules for already-resolved pairs and keeps the rest", () => {
    const referrer = "https://example.com/app/main.js";
    const target: ParsedImportMap = { imports: new Map(), scopes: new Map() };
    const resolved = [
      resolvedModuleRecord("./log.js?name=A", referrer),
      resolvedModuleRecord("lodash", referrer),
      resolvedModuleRecord("pkg/util.js", referrer),
    ];
    const incoming = parseImportMap(
      JSON.stringify({
        imports: {
          "./log.js?name=A": "./log.js?name=B",
          "./log.js?name=C": "./log.js?name=D",
          lodash: "/vendor/lodash.js",
          "pkg/": "/vendor/pkg/",
          "other/": "/vendor/other/",
        },
        scopes: {
          "/app/": { lodash: "/vendor/lodash-app.js", react: "/vendor/react.js" },
          "/elsewhere/": { lodash: "/vendor/lodash-elsewhere.js" },
        },
      }),
      "https://example.com/app/",
    )!;
    mergeImportMap(target, incoming, resolved);
    expect([...target.imports.keys()]).toEqual(["https://example.com/app/log.js?name=C", "other/"]);
    expect([...target.scopes.get("https://example.com/app/")!.keys()]).toEqual(["react"]);
    expect([...target.scopes.get("https://example.com/elsewhere/")!.keys()]).toEqual(["lodash"]);
    expect(resolveImportMapSpecifier("./log.js?name=A", referrer, target)).toBe(
      "https://example.com/app/log.js?name=A",
    );
    expect(resolveImportMapSpecifier("lodash", referrer, target)).toBeNull();
  });

  it("refreshes scope order after a map merge", () => {
    const target = parseImportMaps(
      [JSON.stringify({ scopes: { "/app/": { react: "/vendor/react.js" } } })],
      "https://example.com/",
    );
    expect(
      resolveImportMapSpecifier("react", "https://example.com/app/admin/main.js", target),
    ).toBe("https://example.com/vendor/react.js");

    const incoming = parseImportMap(
      JSON.stringify({ scopes: { "/app/admin/": { react: "/vendor/react-admin.js" } } }),
      "https://example.com/",
    )!;
    mergeImportMap(target, incoming);
    expect(
      resolveImportMapSpecifier("react", "https://example.com/app/admin/main.js", target),
    ).toBe("https://example.com/vendor/react-admin.js");

    const source = importMapModuleSource(target);
    const runtime = new Function(
      `${source.replaceAll("export function", "function")}\nreturn { resolveImportMap };`,
    )() as { resolveImportMap(specifier: string, importer: string): string };
    expect(runtime.resolveImportMap("react", "https://example.com/app/admin/main.js")).toBe(
      "https://example.com/vendor/react-admin.js",
    );
  });

  it("does not let a prefix rule claim a recorded non-special URL", () => {
    const referrer = "https://example.com/app/main.js";
    const target: ParsedImportMap = { imports: new Map(), scopes: new Map() };
    const resolved = [resolvedModuleRecord("data:text/javascript,1", referrer)];
    const incoming = parseImportMap(
      JSON.stringify({ imports: { "data:text/": "/vendor/" } }),
      "https://example.com/app/",
    )!;
    mergeImportMap(target, incoming, resolved);
    expect(target.imports.has("data:text/")).toBe(true);
    expect(resolveImportMapSpecifier("data:text/javascript,1", referrer, target)).toBe(
      "data:text/javascript,1",
    );
  });

  it("keeps the generated runtime resolver in step with the bake-time one", () => {
    const table = parseImportMaps(
      [
        JSON.stringify({
          imports: {
            react: "/vendor/react.js?dev",
            "pkg/": "/vendor/pkg/",
            blocked: null,
            "./legacy.js": "./modern.js",
            "https://cdn.example/old/": "https://cdn.example/new/",
          },
          scopes: {
            "/admin/": { react: "/vendor/react-admin.js" },
            "/js": { react: "/vendor/react-exact.js" },
          },
        }),
      ],
      "https://example.com/app/",
    );
    const source = importMapModuleSource(
      table,
      new Map([
        [
          "https://example.com/vendor/react.js?dev",
          "https://example.com/vendor/react.__ks_query_0.js",
        ],
      ]),
    );
    const runtime = new Function(
      `${source.replaceAll("export function", "function")}\nreturn { resolveImportMap, resolveModuleRegistryUrl };`,
    )() as {
      resolveImportMap(specifier: string, importer: string): string;
      resolveModuleRegistryUrl(url: string): string;
    };
    const cases: [string, string][] = [
      ["react", "https://example.com/app/main.js"],
      ["react", "https://example.com/admin/main.js"],
      ["react", "https://example.com/js"],
      ["react", "https://example.com/js/app.js"],
      ["pkg/a/b.js", "https://example.com/app/main.js"],
      ["pkg/../x.js", "https://example.com/app/main.js"],
      ["blocked", "https://example.com/app/main.js"],
      ["missing", "https://example.com/app/main.js"],
      ["./legacy.js", "https://example.com/app/main.js"],
      ["../app/legacy.js", "https://example.com/app/sub/main.js"],
      ["./other.js", "https://example.com/app/main.js"],
      ["https://cdn.example/old/lib.js", "https://example.com/app/main.js"],
      ["data:text/javascript,1", "https://example.com/app/main.js"],
      ["pkg/", "https://example.com/app/main.js"],
    ];
    for (const [specifier, importer] of cases) {
      const bakeTime = resolveImportMapSpecifier(specifier, importer, table);
      let runtimeAnswer: string | null;
      try {
        runtimeAnswer = runtime.resolveImportMap(specifier, importer);
      } catch (e) {
        expect(e).toBeInstanceOf(TypeError);
        runtimeAnswer = null;
      }
      expect(runtimeAnswer, `${specifier} from ${importer}`).toBe(bakeTime);
    }
    expect(runtime.resolveModuleRegistryUrl("https://example.com/vendor/react.js?dev")).toBe(
      "https://example.com/vendor/react.__ks_query_0.js",
    );
  });

  it("uses mappings for classic literal dynamic imports", () => {
    const result = extractClassicDynamicSeeds(`import("react")`, BASE, (specifier, importer) =>
      resolveImportMapSpecifier(specifier, importer, map),
    );
    expect(result.seeds).toEqual(["https://example.com/vendor/react.js?dev"]);
    expect(result.rewritten).toBe(`import("https://example.com/vendor/react.js?dev")`);
  });

  it("routes import.meta.resolve through the document import map", () => {
    expect(
      rewriteImportMetaResolve(`import.meta.resolve("react")`, "https://example.com/app.js"),
    ).toBe(
      `((specifier) => globalThis.__ks_resolve_import_map(specifier, "https://example.com/app.js"))("react")`,
    );
  });

  it("rewrites only import.meta.resolve syntax inside computed imports", () => {
    expect(
      rewriteImportMetaResolve(
        `new URL("import.meta.resolve", import.meta.url) + import.meta ["resolve"]("react")`,
        "https://example.com/app.js",
      ),
    ).toBe(
      `new URL("import.meta.resolve", import.meta.url) + ((specifier) => globalThis.__ks_resolve_import_map(specifier, "https://example.com/app.js"))("react")`,
    );
  });

  it("rewrites other import.meta uses to one synthetic binding", () => {
    expect(
      rewriteImportMetaResolve(
        `new URL("./x.js", import.meta.url) + (import.meta === import.meta) + import.meta.resolve("pkg")`,
        "https://example.com/app.js",
        "__ks_import_meta",
      ),
    ).toBe(
      `new URL("./x.js", __ks_import_meta.url) + (__ks_import_meta === __ks_import_meta) + __ks_import_meta.resolve("pkg")`,
    );
  });

  it("names a lone query variant apart from its bare url", () => {
    const names = assignModuleRegistryNames([
      "https://example.com/lib.js?preview=1",
      "https://example.com/plain.js",
    ]);
    expect([...names]).toEqual([
      ["https://example.com/lib.js?preview=1", "https://example.com/lib.__ks_query_0.js"],
    ]);
  });

  it("does not bake a query variant under the name of a module its pin rejected", async () => {
    const { descriptors, additionalModules } = await walkModuleGraph({
      descriptors: [
        moduleInline(`import "/lib.js"; if (false) import("/lib.js?preview=1");`),
        {
          src: "/lib.js",
          kind: "module",
          defer: false,
          async: false,
          body: "",
          integrity: "sha384-" + "A".repeat(64),
        },
      ],
      pageUrl: "https://example.com/page.html",
      connectionId: "conn",
      sandboxOutbound: stubOutbound(),
    });
    expect(descriptors[1]?.prefetchError).toBeTruthy();
    const workerdNames = Object.keys(additionalModules).map((k) => k.replace(/[?#].*$/, ""));
    expect(workerdNames).not.toContain("https://example.com/lib.js");
  });

  it("gives query-distinct modules unique workerd registry names", () => {
    const first = "https://example.com/log.js?name=first";
    const second = "https://example.com/log.js?name=second";
    const names = assignModuleRegistryNames([first, second]);
    expect(names.get(first)).toBe("https://example.com/log.__ks_query_0.js");
    expect(names.get(second)).toBe("https://example.com/log.__ks_query_1.js");
  });

  it("accepts a single-use iterable when assigning registry names", () => {
    function* urls() {
      yield "https://example.com/log.js?first";
      yield "https://example.com/log.js?second";
    }
    expect(assignModuleRegistryNames(urls()).size).toBe(2);
  });
});
