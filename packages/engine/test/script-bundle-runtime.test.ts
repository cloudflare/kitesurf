// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { INTERNAL_STATE_SOURCE } from "@kitesurf/page-script";
import { buildScriptBundle } from "../src/eval/script-bundle.ts";
import { PAGE_SCRIPT_COMPAT_DATE, PAGE_SCRIPT_COMPAT_FLAGS } from "../src/eval/page-script.ts";
import type { ParentScriptDescriptor } from "../src/wasm.ts";

function classic(body: string, opts: Partial<ParentScriptDescriptor> = {}): ParentScriptDescriptor {
  return { src: null, kind: "classic", defer: false, async: false, body, ...opts };
}

function module_(body: string, opts: Partial<ParentScriptDescriptor> = {}): ParentScriptDescriptor {
  return { src: null, kind: "module", defer: false, async: false, body, ...opts };
}

async function bootBundleAndCollectGlobals(
  descriptors: ParentScriptDescriptor[],
  globalsToCollect: string[],
): Promise<Record<string, unknown>> {
  const bundle = buildScriptBundle(descriptors);
  const moduleUrls = bundle.moduleScriptUrls;
  const hasRegular = !!bundle.classicRegularSource;
  const hasAsync = !!bundle.classicAsyncSource;

  const pageJsSource = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { getInternalState } from "./internal-state.js";

// Production wires setCurrentScript onto the shared internal-state via
// the dom-shim (current-script.ts) during navigate, before the classic
// buckets call it per segment. This test bakes only the script bundle
// (no dom-shim), so install a no-op stub to stand in for that wiring.
const __ks_is = getInternalState();
if (typeof __ks_is.setCurrentScript !== "function") {
  __ks_is.setCurrentScript = function () {};
}

const globalsToCollect = ${JSON.stringify(globalsToCollect)};
const moduleUrls = ${JSON.stringify(moduleUrls)};
const hasRegular = ${JSON.stringify(hasRegular)};
const hasAsync = ${JSON.stringify(hasAsync)};

// Keep import(spec) opaque to esbuild; workerd resolves it from the module map.
const dynamicImport = new (async function () {}).constructor(
  "spec",
  "return await import(spec);"
);

const runPromise = (async () => {
  // Run regular classic scripts.
  if (hasRegular) {
    const mod = await import("./__ks_user_classic_regular.js");
    const run = (mod && mod.default && mod.default.run) || mod.run;
    if (typeof run !== "function") {
      throw new Error("classic-regular: no run() export");
    }
    await run();
  }
  // Run module scripts in document order.
  for (const url of moduleUrls) {
    await dynamicImport(url);
  }
  // Run async classic scripts.
  if (hasAsync) {
    const mod = await import("./__ks_user_classic_async.js");
    const run = (mod && mod.default && mod.default.run) || mod.run;
    if (typeof run !== "function") {
      throw new Error("classic-async: no run() export");
    }
    await run();
  }
})();

export default class TestProbe extends WorkerEntrypoint {
  async fetch() {
    try {
      await runPromise;
    } catch (err) {
      return Response.json({
        ok: false,
        error: String(err && err.message ? err.message : err),
        stack: err && err.stack ? String(err.stack) : null,
      });
    }
    const out = { ok: true, globals: {} };
    for (const name of globalsToCollect) {
      try {
        const v = globalThis[name];
        if (typeof v === "function") {
          out.globals[name] = { kind: "function", result: v() };
        } else if (typeof v === "undefined") {
          out.globals[name] = { kind: "undefined" };
        } else {
          out.globals[name] = { kind: typeof v, value: v };
        }
      } catch (e) {
        out.globals[name] = { kind: "error", error: String(e) };
      }
    }
    return Response.json(out);
  }
}
`;

  const modules: Record<string, string | { cjs: string } | { json: unknown }> = {
    "page.js": pageJsSource,
    "internal-state.js": INTERNAL_STATE_SOURCE,
  };
  if (bundle.classicRegularSource) {
    modules["__ks_user_classic_regular.js"] = { cjs: bundle.classicRegularSource };
  }
  if (bundle.classicAsyncSource) {
    modules["__ks_user_classic_async.js"] = { cjs: bundle.classicAsyncSource };
  }
  for (const [url, body] of Object.entries(bundle.additionalModules)) {
    if (modules[url] !== undefined) continue;
    modules[url] = body;
  }

  const name = "test-bundle-" + crypto.randomUUID();
  const stub = env.LOADER.get(name, () => ({
    compatibilityDate: PAGE_SCRIPT_COMPAT_DATE,
    compatibilityFlags: [...PAGE_SCRIPT_COMPAT_FLAGS],
    mainModule: "page.js",
    modules,
  }));

  const entrypoint = stub.getEntrypoint() as Fetcher;
  const res = await entrypoint.fetch(new Request("http://probe/"));
  const body = (await res.json()) as {
    ok: boolean;
    error?: string;
    stack?: string;
    globals?: Record<string, { kind: string; value?: unknown; result?: unknown; error?: string }>;
  };

  if (!body.ok) {
    throw new Error(`bundle runtime threw: ${body.error}\n${body.stack ?? ""}`);
  }
  return body.globals!;
}

describe("legacy bucket runtime behaviour", () => {
  it("classic bucket runs first, then modules — same-bucket order is document order", async () => {
    const globals = await bootBundleAndCollectGlobals(
      [
        classic(`
          globalThis.__log = [];
          globalThis.__log.push("classic-1");
        `),
        module_(`
          globalThis.__log.push("module-1");
        `),
        classic(`
          globalThis.__log.push("classic-2");
        `),
        module_(`
          globalThis.__log.push("module-2");
        `),
      ],
      ["__log"],
    );

    expect(globals.__log).toEqual({
      kind: "object",
      value: ["classic-1", "classic-2", "module-1", "module-2"],
    });
  });

  it("classic bodies share a function scope so var/function/let/const are cross-visible", async () => {
    const globals = await bootBundleAndCollectGlobals(
      [
        classic(`
          var v = "var-value";
          let l = "let-value";
          const c = "const-value";
          function f() { return "fn-value"; }
        `),
        classic(`
          // Bare identifiers resolve in the shared classic-bucket scope.
          globalThis.__sawVar = v;
          globalThis.__sawLet = l;
          globalThis.__sawConst = c;
          globalThis.__sawFn = f();
        `),
      ],
      ["__sawVar", "__sawLet", "__sawConst", "__sawFn"],
    );
    expect(globals.__sawVar).toEqual({ kind: "string", value: "var-value" });
    expect(globals.__sawLet).toEqual({ kind: "string", value: "let-value" });
    expect(globals.__sawConst).toEqual({ kind: "string", value: "const-value" });
    expect(globals.__sawFn).toEqual({ kind: "string", value: "fn-value" });
  });

  it("sloppy-mode bare assignment lands on globalThis (visible to subsequent modules)", async () => {
    const globals = await bootBundleAndCollectGlobals(
      [
        classic(`
          // The CJS wrapper runs sloppy-mode, so this assignment lands globally.
          implicitGlobal = "implicit-value";
        `),
        module_(`
          globalThis.__moduleSawImplicit = globalThis.implicitGlobal;
        `),
      ],
      ["implicitGlobal", "__moduleSawImplicit"],
    );
    expect(globals.implicitGlobal).toEqual({ kind: "string", value: "implicit-value" });
    expect(globals.__moduleSawImplicit).toEqual({
      kind: "string",
      value: "implicit-value",
    });
  });

  it("var/function/let/const declared in classic bucket ARE promoted to globalThis (visible to modules)", async () => {
    const globals = await bootBundleAndCollectGlobals(
      [
        classic(`
          var v = 1;
          let l = 2;
          const c = 3;
          function f() {}
        `),
        module_(`
          globalThis.__modSawV = globalThis.v;
          globalThis.__modSawL = globalThis.l;
          globalThis.__modSawC = globalThis.c;
          globalThis.__modSawF = typeof globalThis.f;
        `),
      ],
      ["__modSawV", "__modSawL", "__modSawC", "__modSawF"],
    );
    expect(globals.__modSawV).toEqual({ kind: "number", value: 1 });
    expect(globals.__modSawL).toEqual({ kind: "number", value: 2 });
    expect(globals.__modSawC).toEqual({ kind: "number", value: 3 });
    expect(globals.__modSawF).toEqual({ kind: "string", value: "function" });
  });

  it("classic-async bucket runs AFTER modules", async () => {
    const globals = await bootBundleAndCollectGlobals(
      [
        classic(`
          globalThis.__order = [];
          globalThis.__order.push("regular");
        `),
        module_(`globalThis.__order.push("module");`),
        classic("", {
          src: "/a.js",
          async: true,
          prefetchedSource: 'globalThis.__order.push("async");',
        }),
      ],
      ["__order"],
    );
    expect(globals.__order).toEqual({
      kind: "object",
      value: ["regular", "module", "async"],
    });
  });

  it("top-level var is a LIVE globalThis binding — post-bucket reassignment is visible", async () => {
    const globals = await bootBundleAndCollectGlobals(
      [
        classic(`
          var flag = "before";
          function flip() { flag = "after"; }
        `),
        module_(`
          flip();
          globalThis.__afterFlip = globalThis.flag;
        `),
      ],
      ["__afterFlip"],
    );
    expect(globals.__afterFlip).toEqual({ kind: "string", value: "after" });
  });

  it("reads before a top-level var declaration see undefined, not a throw", async () => {
    const globals = await bootBundleAndCollectGlobals(
      [
        classic(`
          globalThis.__preRead = typeof hoisted + ":" + String(hoisted);
          var hoisted = 5;
          globalThis.__postRead = hoisted;
        `),
      ],
      ["__preRead", "__postRead"],
    );
    expect(globals.__preRead).toEqual({ kind: "string", value: "undefined:undefined" });
    expect(globals.__postRead).toEqual({ kind: "number", value: 5 });
  });

  it("destructuring var declarations keep their keyword and still execute", async () => {
    const globals = await bootBundleAndCollectGlobals(
      [
        classic(`
          var { a } = { a: 7 };
          globalThis.__destructured = a;
        `),
      ],
      ["__destructured"],
    );
    expect(globals.__destructured).toEqual({ kind: "number", value: 7 });
  });

  it("top-level `var origin` replaces workerd's readonly native and writes land", async () => {
    const globals = await bootBundleAndCollectGlobals(
      [
        classic(`
          var origin = "http://web-platform.test:8000";
          globalThis.__originRead = origin;
        `),
      ],
      ["origin", "__originRead"],
    );
    expect(globals.__originRead).toEqual({
      kind: "string",
      value: "http://web-platform.test:8000",
    });
    expect(globals.origin).toEqual({ kind: "string", value: "http://web-platform.test:8000" });
  });

  it("module/exports/require declarations never leak to globalThis", async () => {
    const globals = await bootBundleAndCollectGlobals(
      [
        classic(`
          var module = 1;
          var exports = 2;
        `),
        module_(`
          globalThis.__moduleLeak = typeof globalThis.module;
          globalThis.__exportsLeak = typeof globalThis.exports;
        `),
      ],
      ["__moduleLeak", "__exportsLeak"],
    );
    expect(globals.__moduleLeak).toEqual({ kind: "string", value: "undefined" });
    expect(globals.__exportsLeak).toEqual({ kind: "string", value: "undefined" });
  });
});

describe("script URLs in generated comments", () => {
  it.each(["\n", "\u2028"])("code after a line terminator in src does not run (%j)", async (t) => {
    const globals = await bootBundleAndCollectGlobals(
      [
        classic("", {
          src: `https://cdn.test/a.js${t}globalThis.__injected = 1;//`,
          prefetchedSource: "var a = 1;\nglobalThis.__ran = a;",
        }),
      ],
      ["__injected", "__ran"],
    );
    expect(globals.__injected).toEqual({ kind: "undefined" });
    expect(globals.__ran).toEqual({ kind: "number", value: 1 });
  });
});
