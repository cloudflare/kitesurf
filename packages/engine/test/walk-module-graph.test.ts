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
  MAX_IMPORT_MAP_WORK,
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
import type { ParentScriptDescriptor, ScannedModulePreload } from "../src/wasm.ts";
import { bakedJsonModuleName } from "../../page-script/src/baked-module.ts";

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

  it("matches the replaced attribute regexes without rescanning malformed markup", () => {
    const cases: Array<[string, string[]]> = [
      ['<astro-island component-url="/a.js>"/b.js">', []],
      ['<astro-island component-url="">', []],
      ["<astro-island component-url='/a.js'>", []],
      ["<astro-island component-url=/a.js>", []],
      [
        '<astro-island component-url="/a.js" component-url="/b.js">' +
          '<astro-island component-url="/a.js">',
        ["https://example.com/a.js", "https://example.com/b.js"],
      ],
      ['<ASTRO-ISLAND RENDERER-URL="https://cdn.example/r.js">', ["https://cdn.example/r.js"]],
    ];
    for (const [html, urls] of cases) expect(astroIslandModuleUrls(html, BASE)).toEqual(urls);
    const start = performance.now();
    const openers = ('<astro-island component-url="' + "a".repeat(32)).repeat(8000);
    expect(astroIslandModuleUrls(openers, BASE)).toEqual([]);
    expect(astroIslandModuleUrls(`<astro-island${" component-url=".repeat(4000)}>`, BASE)).toEqual(
      [],
    );
    expect(performance.now() - start).toBeLessThan(250);
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
    expect(rewritten).toMatch(/__ks_import_\w+\("@wordpress\/vips\/worker"\)/);
    expect(rewritten).not.toMatch(/(?<!__ks_)import\("@wordpress/);
  });

  it("treats backtick bare specifiers the same", () => {
    const { rewritten, seeds } = extractClassicDynamicSeeds("import(`lodash-es`).then(go);", BASE);
    expect(seeds).toEqual([]);
    expect(rewritten).toMatch(/__ks_import_\w+\("lodash-es"\)/);
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
    expect(rewritten).toMatch(/__ks_import_\w+\(name \+ "\.js"\)/);
  });

  it("keeps the options argument when absolutizing a literal", () => {
    const { rewritten, seeds } = extractClassicDynamicSeeds(
      `import("./cfg.json", { with: { type: "json" } })`,
      BASE,
    );
    expect(seeds).toEqual(["https://example.com/js/cfg.json"]);
    expect(rewritten).toBe(`import("https://example.com/js/cfg.json", { with: { type: "json" } })`);
  });

  it("forwards a computed import's options to __ks_import", () => {
    const { rewritten } = extractClassicDynamicSeeds(
      'import(`./${name}.json`, { with: { type: "json" } })',
      BASE,
    );
    expect(rewritten.split("\n")[0]).toMatch(
      /^__ks_import_\w+\(`\.\/\$\{name\}\.json`, \{ with: \{ type: "json" \} \}\)$/,
    );
  });

  it("hoists one binding per base instead of repeating it at every call", () => {
    const base = `https://example.com/${"a".repeat(4096)}/app.js`;
    const many = `import(importPath);`.repeat(1500);
    const bulk = extractClassicDynamicSeeds(`${many}import("./chunk.js");`, base);
    expect(bulk.seeds).toEqual([`https://example.com/${"a".repeat(4096)}/chunk.js`]);
    expect(bulk.rewritten.split(base)).toHaveLength(2);
    expect(bulk.rewritten.length).toBeLessThan(many.length + base.length + 30_000);
  });
});

describe("walkModuleGraph classic import referrers", () => {
  it("keeps a referrer per colliding base in one bundle scope", async () => {
    // Both bases hash to 76f2b8a5, so a hash-named binding would collide in one scope.
    const bases = [
      "https://example.com/static/a468471.js",
      "https://example.com/static/a1063000.js",
    ];
    const { descriptors } = await walkModuleGraph({
      descriptors: bases.map((url) => classicExternal(url, `import(importPath);`)),
      pageUrl: "https://example.com/page.html",
      connectionId: "conn",
      options: {},
      sandboxOutbound: stubOutbound(),
    });
    const calls: unknown[][] = [];
    const bundle = descriptors.map((d) => d.prefetchedSource).join("\n");
    const spy = (...args: unknown[]) => calls.push(args);
    new Function("__ks_import", "importPath", bundle)(spy, "chunk.js");
    expect(calls).toEqual(bases.map((url) => ["chunk.js", url, undefined]));
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

  // Each input makes the lexer skip a live call while a quote that is not a string would open one,
  // so a scan that guesses where strings end can leave the call native.
  it.each([
    ["a nested template", 'const a = `${`x`}`; with ({}) /a\\//.test(""); import("./x.js");'],
    [
      "a quote in a regex after a condition",
      'var s = ""; if (s === ")") /\'/.test(s); with ({}) /a\\//.test(""); import("./x.js"); //\'',
    ],
    [
      "await before a regex",
      '(async () => { await /\'/; with ({}) /a\\//.test(""); import("./x.js"); //\'\n})();',
    ],
  ])("leaves no native import() when the script holds %s", (_, body) => {
    expect(() => new Function(body)).not.toThrow();
    const { rewritten } = extractClassicDynamicSeeds(body, BASE);
    expect(nativeCalls(rewritten)).toBeNull();
    expect(rewritten).toContain("__ks_import");
  });

  it("publishes the runtime helper so a script built from a string can call it", () => {
    // The string keeps its call renamed, and an inserted script runs it in the page realm, where a
    // bare name resolves through the global object, which is why the helper must be published.
    const body = `const s = 'import("./a.js")'; globalThis.out = s;`;
    const { rewritten } = extractClassicDynamicSeeds(body, BASE);
    const page: { out?: string; [key: string]: unknown } = {};
    new Function("globalThis", "__ks_import", rewritten)(page, () => {});
    const helper = Object.keys(page).find((key) => key.startsWith("__ks_import_"));
    expect(helper).toBeDefined();
    expect(typeof page[helper as string]).toBe("function");
    expect(page.out).toContain(`${helper}(`);
    expect(nativeCalls(page.out ?? "")).toBeNull();
  });

  it("publishes the helper after a use strict prologue", () => {
    const body = `"use strict";\nconst s = 'import("./a.js")';`;
    const { rewritten } = extractClassicDynamicSeeds(body, BASE);
    expect(rewritten.startsWith(`"use strict";\n`)).toBe(true);
    expect(rewritten).toContain("globalThis.__ks_import_");
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

  it("sends an import() after a --> comment that ends with a dot to the runtime loader", () => {
    const body = `globalThis.x = 1;\n--> Load the chunk.\nimport("./x.js");`;
    expect(() => new Function(body)).not.toThrow();
    const { rewritten, seeds } = extractClassicDynamicSeeds(body, BASE);
    // The lexer does not treat `-->` as a comment here, so the call is renamed, not absolutized.
    expect(seeds).toEqual([]);
    expect(nativeCalls(rewritten)).toBeNull();
    expect(rewritten).toContain("__ks_import");
    expect(rewritten).toContain(JSON.stringify(BASE));
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
      /^globalThis\.__ks_import_\w+ \?\?= __ks_import_\w+;\n\{\}\n\/\}\/\.test\(""\); a\.import\(1\); a\?\.import\(2\); reimport\(3\); __ks_import_\w+\("\.\/x\.js"\);\n/,
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
      ["./chunk.js", BASE, { with: { type: "json" } }],
      ["./c.js", other, undefined],
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
    expect(runClassic(rewritten.replace(/import\("[^"]*"\);/, ""))).toEqual([
      ["./b.js", BASE, undefined],
    ]);
  });

  it("sends a call nested in another call to the runtime loader", () => {
    const { rewritten, seeds } = extractClassicDynamicSeeds(`import(import("./a.js"));`, BASE);
    expect(seeds).toEqual([]);
    expect(nativeCalls(rewritten)).toBeNull();
    expect(runClassic(rewritten).length).toBe(2);
  });

  it("keeps a method named import valid", () => {
    const { rewritten } = extractClassicDynamicSeeds(
      `{}\n/}/.test(""); const o = { import(x) { return x; } }; import("./x.js");`,
      BASE,
    );
    expect(runClassic(rewritten)).toEqual([["./x.js", BASE, undefined]]);
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
  redirects: Record<string, string> = {},
): SandboxOutboundOverride {
  const fetcher = {
    fetch: async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (delays[url]) await new Promise((r) => setTimeout(r, delays[url]));
      const location = redirects[url];
      return new Response(location ? null : (bodies[url] ?? "export default 1;"), {
        status: location ? 302 : 200,
        headers: location ? { location } : { "content-type": "text/javascript" },
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
      `__ks_import_0("file:///bundle/internal-state.js");\n` +
        `function __ks_import_0(s, o) { return __ks_import(s, ${JSON.stringify(PAGE)}, o); }`,
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
  it("collects script-destination modulepreload records once, with their nonce and integrity", () => {
    // Hrefs arrive decoded from the document scanner; this helper only resolves and dedupes them.
    const links: ScannedModulePreload[] = [
      { href: "/a.js?x=1&y=2", nonce: "n1", integrity: null },
      { href: "b.js", nonce: null, integrity: null },
      { href: "/a.js?x=1&y=2", nonce: "later", integrity: "sha384-later" },
      { href: "https://cdn.example/c.js", nonce: null, integrity: null },
      { href: "data:text/javascript,export{}", nonce: null, integrity: null },
      { href: "http://[", nonce: null, integrity: null },
      { href: "/sri.js", nonce: null, integrity: "sha384-x" },
    ];
    expect(modulePreloadSeeds(links, "https://site.example/dir/page")).toEqual([
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
          preloadSeeds: modulePreloadSeeds([{ href: "/dep.js", nonce: null, integrity }], PAGE),
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

describe("walkModuleGraph speculative inserted scripts", () => {
  const PAGE = "https://example.com/page.html";
  const walk = (body: string) =>
    walkModuleGraph({
      descriptors: [{ ...moduleInline(`import "/x.js?v=1";`), scriptDomIndex: 0 }],
      insertedDescriptors: [classicExternal("/learned.js", body)],
      pageUrl: PAGE,
      connectionId: "conn",
      options: {
        importMaps: [
          {
            source: JSON.stringify({ imports: { "/x.js?v=1": "/x.js?v=2" } }),
            baseUrl: PAGE,
            scriptDomIndex: 1,
          },
        ],
      },
      sandboxOutbound: stubOutbound(),
    });

  it.each([
    [`import("./dep.js").then(go);`, `import("https://example.com/dep.js").then(go);`],
    [`import("/x.js?v=1");`, /import\("https:\/\/example\.com\/x\.__ks_query_\d+\.js"\);/],
    [
      `import(spec);`,
      /^__ks_import_\d+\(spec\);\nfunction __ks_import_\d+\(s, o\) \{ return __ks_import\(s, "https:\/\/example\.com\/learned\.js", o\); \}$/,
    ],
    [`{}\n/}/.test(""); import("./internal-state.js")`, /__ks_import_/],
  ])("walks the inserted classic %# against the final map", async (body, expected) => {
    const result = await walk(body);
    expect(result.insertedDescriptors).toHaveLength(1);
    expect(result.insertedDescriptors[0]!.prefetchedSource).toMatch(expected);
    expect(result.descriptors.map((d) => d.src)).toEqual([null]);
  });

  it("keeps the seed of an already-absolute literal whose text is unchanged", async () => {
    const body = `import("https://example.com/abs.js");`;
    const result = await walk(body);
    expect(result.insertedDescriptors[0]!.prefetchedSource).toBe(body);
    expect(Object.keys(result.additionalModules)).toContain("https://example.com/abs.js");
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
    // The URL parser strips this leading tab, so the specifier is URL-like.
    expect(resolveImportMapSpecifier("\thttps://cdn.test/x.js", "https://example.com/", map)).toBe(
      "https://cdn.test/x.js",
    );
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

  it("fails a static importer when a rejected pin equals a query variant's alias", async () => {
    const { descriptors, additionalModules } = await walkModuleGraph({
      descriptors: [
        moduleInline(`import "/lib.__ks_query_0.js"; if (false) import("/lib.js?preview=1");`),
        {
          src: "/lib.__ks_query_0.js",
          kind: "module",
          defer: false,
          async: false,
          body: "",
          integrity: "sha384-" + "A".repeat(64),
        },
      ],
      pageUrl: "https://example.com/page.html",
      connectionId: "conn",
      sandboxOutbound: stubOutbound({
        "https://example.com/lib.js?preview=1": "export const preview = 1;",
      }),
    });
    expect(additionalModules["https://example.com/lib.__ks_query_0.js"]).toContain(
      "export const preview = 1;",
    );
    expect(descriptors[0]?.prefetchError).toMatch(
      /Failed to load static module https:\/\/example\.com\/lib\.__ks_query_0\.js/,
    );
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

  it("looks a baked JSON record up by its registry name", () => {
    const requested = "https://example.com/config.json?preview=1";
    const other = "https://example.com/other.json";
    const registry = assignModuleRegistryNames([requested, other]);
    const resolveRegistryUrl = (url: unknown) => registry.get(String(url)) ?? String(url);
    const bakedJsonNames = new Set([registry.get(requested)!]);
    // The bake key is the alias, so the requested URL alone never matches it.
    expect(bakedJsonModuleName(requested, bakedJsonNames, resolveRegistryUrl)).toBe(
      "https://example.com/config.__ks_query_0.json",
    );
    // A URL nothing baked as JSON stays unresolved, so the gate parses it as JSON.
    expect(bakedJsonModuleName(other, bakedJsonNames, resolveRegistryUrl)).toBeUndefined();
  });
});

describe("walkModuleGraph module response urls", () => {
  const PKG = "https://cdn.example/pkg";
  const MAIN = "https://cdn.example/pkg/dist/main.js";
  const HELPER = "https://cdn.example/pkg/dist/helper.js";

  it("resolves and refers against the module response url", async () => {
    const { additionalModules } = await walkModuleGraph({
      descriptors: [moduleInline(`import ${JSON.stringify(PKG)};`)],
      pageUrl: "https://example.com/page.html",
      connectionId: "conn",
      sandboxOutbound: stubOutbound(
        { [MAIN]: `import "./helper.js"; globalThis.u = import.meta.url;` },
        {},
        { [PKG]: "/pkg/dist/main.js" },
      ),
    });
    expect(String(additionalModules[PKG])).toContain(`import "${HELPER}"`);
    expect(String(additionalModules[PKG])).toContain(`url:${JSON.stringify(MAIN)}`);
    const upgraded = await walkModuleGraph({
      descriptors: [moduleInline(`import "http://cdn.example/plain.js";`)],
      pageUrl: "https://example.com/page.html",
      connectionId: "conn",
      options: {
        gate: {
          documentUrl: "https://example.com/page.html",
          policies: [],
          reportOnlyPolicies: [],
          upgradeInsecureRequests: true,
        },
      },
      sandboxOutbound: stubOutbound({
        "https://cdn.example/plain.js": "export const upgraded = 1;",
      }),
    });
    expect(String(upgraded.additionalModules["http://cdn.example/plain.js"])).toContain("upgraded");
  });
});

describe("import map budgets", () => {
  const PAGE = "https://example.com/page.html";
  const walk = (
    bodies: string[],
    importMaps: { source: string; baseUrl: string; scriptDomIndex: number }[] = [],
  ) =>
    walkModuleGraph({
      descriptors: bodies.map((body, scriptDomIndex): ParentScriptDescriptor => ({
        src: null,
        kind: "classic",
        defer: false,
        async: false,
        body,
        scriptDomIndex,
      })),
      pageUrl: PAGE,
      connectionId: "conn",
      options: { importMaps },
      sandboxOutbound: stubOutbound(),
    });
  const sourceMap = (source: string, scriptDomIndex = 1) => [
    { source, baseUrl: PAGE, scriptDomIndex },
  ];
  const map = (value: unknown, scriptDomIndex = 1) =>
    sourceMap(JSON.stringify(value), scriptDomIndex);
  const keys = (count: number, prefix: string) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i}`, "/x.js"]));
  const scopes = (count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`/${"s".repeat(i + 1)}/`, {}]));
  // 100 literals per script keeps the pre-existing per-body rewrite linear.
  const literalScripts = (count: number, prefix = "m") => {
    const bodies: string[] = [];
    for (let i = 0; i < count; i += 100) {
      const chunk = Array.from({ length: Math.min(100, count - i) }, (_, j) => `${prefix}${i + j}`);
      bodies.push(chunk.map((name) => `import("${name}");`).join(""));
    }
    return bodies;
  };
  // Keys and literals share a 2,000-character prefix and differ only at the end.
  const long = "p".repeat(2_000);
  const longKeys = (count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`${long}k${i}/`, "/x.js"]));
  const outcome = async (run: () => Promise<unknown>) => {
    try {
      return {
        result: (await run()) as {
          importMapModuleSource: string;
          descriptors: ParentScriptDescriptor[];
          additionalModules: Record<string, unknown>;
        },
      };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
  // Every map carries this rule, so "applied" means the map survived and "dropped" means it was
  // ignored the way an invalid map is.
  const MARK = `{"imports":{"mark":"/vendor/mark.js"}}`;
  const markMap = (imports: Record<string, unknown> = {}) =>
    map({ imports: { mark: "/vendor/mark.js", ...imports } });
  const paddedMarkMap = (bytes: number) => " ".repeat(bytes - MARK.length) + MARK;

  it("keeps a map one step under each limit and ignores one step over", async () => {
    const one = [`import("m0");`];
    const rows: Array<[string, () => Promise<unknown>, string, string?, string?]> = [
      ["16384 entries", () => walk(one, markMap(keys(16_383, "k"))), "applied"],
      ["16385 entries", () => walk(one, markMap(keys(16_384, "k"))), "dropped"],
      [
        "256 scopes",
        () => walk(one, map({ imports: { mark: "/vendor/mark.js" }, scopes: scopes(256) })),
        "applied",
      ],
      [
        "257 scopes",
        () => walk(one, map({ imports: { mark: "/vendor/mark.js" }, scopes: scopes(257) })),
        "dropped",
      ],
      ["2048-unit key", () => walk(one, markMap({ ["a".repeat(2_048)]: "/x.js" })), "applied"],
      ["2049-unit key", () => walk(one, markMap({ ["a".repeat(2_049)]: "/x.js" })), "dropped"],
      ["2 MiB source", () => walk(one, sourceMap(paddedMarkMap(2 * 1024 * 1024))), "applied"],
      [
        "2 MiB + 1 source",
        () => walk(one, sourceMap(paddedMarkMap(2 * 1024 * 1024 + 1))),
        "dropped",
      ],
      [
        "8192 recorded resolutions",
        () => walk(literalScripts(8_192), markMap(keys(8_192, "m"))),
        "ok",
      ],
      [
        "8193 recorded resolutions",
        () => walk(literalScripts(8_193), markMap(keys(8_193, "m"))),
        "past-record-limit",
        undefined,
        'import("https://example.com/x.js")',
      ],
      [
        "1 long record against 900 long keys",
        () => walk([`import("${long}a0");`], markMap(longKeys(900))),
        "applied",
      ],
      [
        "300 long records against 900 long keys",
        () =>
          walk(
            ["", `import("mark");`, ...literalScripts(300, long), `import("mark");`],
            markMap(longKeys(900)),
          ),
        "degraded",
        "mark",
        'import("https://example.com/vendor/mark.js")',
      ],
    ];
    for (const [label, run, expected, unresolved, resolvedBefore] of rows) {
      const result = await outcome(run);
      if (expected === "applied") {
        expect(result.error, label).toBeUndefined();
        expect(result.result?.importMapModuleSource, label).toContain("vendor/mark.js");
      } else if (expected === "dropped") {
        expect(result.error, label).toBeUndefined();
        expect(result.result?.importMapModuleSource, label).not.toContain("vendor/mark.js");
      } else if (expected === "ok") {
        expect(result.error, label).toBeUndefined();
      } else if (expected === "past-record-limit") {
        // Recording stops at the limit; resolution keeps working through the maps already merged,
        // so even the literal that crossed the limit resolves.
        expect(result.error, label).toBeUndefined();
        const descriptors = result.result?.descriptors ?? [];
        const lastBody = descriptors[descriptors.length - 1]?.body ?? "";
        expect(lastBody, label).not.toMatch(/__ks_import_/);
        expect(lastBody, label).toContain(resolvedBefore ?? "");
      } else {
        // Degraded: the walk returns, and the import that crossed the limit stays unresolved
        // while the imports under it resolved through the same map.
        expect(result.error, label).toBeUndefined();
        const descriptors = result.result?.descriptors ?? [];
        const lastBody = descriptors[descriptors.length - 1]?.body ?? "";
        const calls = lastBody.match(/__ks_import_\d+\("[^"]*"\)/g) ?? [];
        expect(calls, label).toHaveLength(1);
        expect(calls[0], label).toContain(`(${JSON.stringify(unresolved ?? "")})`);
        if (resolvedBefore) {
          expect(descriptors.map((d) => d.body).join(""), label).toContain(resolvedBefore);
        }
      }
    }
  });

  it("keeps resolving past the record limit without degrading the whole document", async () => {
    // 8,192 literals fill the record list; the inline module's static import is the one that
    // crosses it, and the walk must still resolve ./dep.js against the (empty) map.
    const result = await outcome(() =>
      walkModuleGraph({
        descriptors: [
          ...literalScripts(8_192).map((body, scriptDomIndex): ParentScriptDescriptor => ({
            src: null,
            kind: "classic",
            defer: false,
            async: false,
            body,
            scriptDomIndex,
          })),
          { ...moduleInline(`import "./dep.js";`), scriptDomIndex: 100 },
        ],
        pageUrl: PAGE,
        connectionId: "conn",
        sandboxOutbound: stubOutbound(),
      }),
    );
    expect(result.error).toBeUndefined();
    const entry = result.result?.descriptors.find((d) => d.kind === "module");
    expect(entry?.prefetchError).toBeUndefined();
    expect(result.result?.additionalModules["https://example.com/dep.js"]).toBeDefined();
  });

  it("stops charging merge work as soon as the budget is spent", () => {
    const start = MAX_IMPORT_MAP_WORK - 1_000;
    const budget = { entries: 0, scopes: 0, records: 0, work: start, degraded: false };
    const referrer = "https://example.com/app/main.js";
    const target: ParsedImportMap = { imports: new Map(), scopes: new Map() };
    const prefixKeys = Object.fromEntries(
      Array.from({ length: 4_096 }, (_, i) => [`p${i}/`, "/x.js"]),
    );
    const incoming = parseImportMap(
      JSON.stringify({ imports: prefixKeys, scopes: { "/app/": prefixKeys } }),
      "https://example.com/app/",
    )!;
    const resolved = Array.from({ length: 512 }, (_, i) =>
      resolvedModuleRecord(`p${i}/x.js`, referrer),
    );
    mergeImportMap(target, incoming, resolved, budget);
    expect(budget.work - start).toBeLessThan(10_000);
  });
});

describe("walkModuleGraph import.meta against dynamic import ranges", () => {
  const SELF = JSON.stringify("https://example.com/__kitesurf_inline_0.js");
  const RESOLVE = `((specifier) => globalThis.__ks_resolve_import_map(specifier, ${SELF}))`;
  const walk = async (body: string) => {
    const { additionalModules } = await walkModuleGraph({
      descriptors: [moduleInline(body)],
      pageUrl: "https://example.com/page.html",
      connectionId: "conn",
      sandboxOutbound: stubOutbound({ "https://example.com/dep.js": "export default 1;" }),
    });
    return additionalModules["https://example.com/__kitesurf_inline_0.js"];
  };

  it.each([
    ["a standalone resolve", `import.meta.resolve("a");`, `${RESOLVE}("a");`],
    [
      "a resolve inside a computed import",
      `import(import.meta.resolve("a"));`,
      `__ks_import(${RESOLVE}("a"), ${SELF});`,
    ],
    [
      "a resolve after a nested dynamic import",
      `import(import("/dep.js") + import.meta.resolve("b"));`,
      `__ks_import(import("/dep.js") + ${RESOLVE}("b"), ${SELF});`,
    ],
    [
      "a resolve outside every dynamic import",
      `import("a");import.meta.resolve("b");`,
      `__ks_import("a", ${SELF});${RESOLVE}("b");`,
    ],
  ])("keeps the rewrite for %s", async (_, body, expected) => {
    expect(await walk(body)).toBe(expected);
  });

  it("tests 20,000 meta records against 10,000 ranges", async () => {
    const source = `import("/dep.js");import.meta.url;import.meta.url;`.repeat(10_000);
    const start = performance.now();
    expect(await walk(source)).toBe(source);
    expect(performance.now() - start).toBeLessThan(600);
  });
});
