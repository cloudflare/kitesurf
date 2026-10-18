// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

type Result = { ok: true; value: unknown } | { ok: false; error: string };

async function runScenario(
  modules: Record<string, string | { cjs: string }>,
  mainModule = "page.js",
): Promise<Result> {
  const name = "module-eval-scope-" + crypto.randomUUID();
  try {
    const stub = env.LOADER.get(name, () => ({
      compatibilityDate: "2025-10-01",
      compatibilityFlags: ["nodejs_compat"],
      mainModule,
      modules,
    }));
    const entrypoint = stub.getEntrypoint() as Fetcher;
    const res = await entrypoint.fetch(new Request("http://probe/"));
    return { ok: true, value: await res.text() };
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: err?.message ?? String(e) };
  }
}

describe("workerd module-eval scope", () => {
  it("A) static-import of helper with top-level setTimeout fails at factory time", async () => {
    const r = await runScenario({
      "page.js":
        'import "./helper.js";\n' +
        'export default { async fetch() { return new Response("hello-from-A"); } };\n',
      "helper.js": "setTimeout(() => {}, 0);\n" + "export const ok = true;\n",
    });
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toMatch(
      /Disallowed operation called within global scope|setting a timeout/,
    );
  });

  it("B) plain mainModule with no I/O works", async () => {
    const r = await runScenario({
      "page.js": 'export default { async fetch() { return new Response("ok-B"); } };\n',
    });
    expect(r.ok).toBe(true);
    expect((r as { ok: true; value: unknown }).value).toBe("ok-B");
  });

  it("C) dynamic-import from fetch() handler — top-level setTimeout in imported module", async () => {
    const r = await runScenario({
      "page.js":
        "export default {\n" +
        "  async fetch() {\n" +
        "    try {\n" +
        '      const mod = await import("./helper.js");\n' +
        '      return new Response("imported-ok: " + JSON.stringify({ exported: mod.ok }));\n' +
        "    } catch (e) {\n" +
        '      return new Response("threw: " + (e && e.message || String(e)));\n' +
        "    }\n" +
        "  }\n" +
        "};\n",
      "helper.js": "setTimeout(() => {}, 0);\n" + "export const ok = true;\n",
    });
    console.log(`[probe C] ok=${r.ok} body=${(r as any).value} err=${(r as any).error}`);
    expect(r).toBeDefined();
  });

  it("D) dynamic-import from fetch() handler — top-level fetch() in imported module", async () => {
    const r = await runScenario({
      "page.js":
        "export default {\n" +
        "  async fetch() {\n" +
        "    try {\n" +
        '      const mod = await import("./helper.js");\n' +
        '      return new Response("imported-ok: " + JSON.stringify({ exported: typeof mod.p }));\n' +
        "    } catch (e) {\n" +
        '      return new Response("threw: " + (e && e.message || String(e)));\n' +
        "    }\n" +
        "  }\n" +
        "};\n",
      "helper.js": 'export const p = fetch("http://example.invalid/").catch(() => null);\n',
    });
    console.log(`[probe D] ok=${r.ok} body=${(r as any).value} err=${(r as any).error}`);
    expect(r).toBeDefined();
  });

  it("E) dynamic-import from fetch() handler — top-level new AbortController() in imported module", async () => {
    const r = await runScenario({
      "page.js":
        "export default {\n" +
        "  async fetch() {\n" +
        "    try {\n" +
        '      const mod = await import("./helper.js");\n' +
        '      return new Response("imported-ok: " + JSON.stringify({ aborted: mod.signal.aborted }));\n' +
        "    } catch (e) {\n" +
        '      return new Response("threw: " + (e && e.message || String(e)));\n' +
        "    }\n" +
        "  }\n" +
        "};\n",
      "helper.js": "const c = new AbortController();\n" + "export const signal = c.signal;\n",
    });
    console.log(`[probe E] ok=${r.ok} body=${(r as any).value} err=${(r as any).error}`);
    expect(r).toBeDefined();
  });

  it("F) CJS-wrapped helper with I/O inside async function works", async () => {
    const r = await runScenario({
      "page.js":
        "export default {\n" +
        "  async fetch() {\n" +
        "    try {\n" +
        '      const mod = await import("./helper.js");\n' +
        "      const { signal } = await mod.default.run();\n" +
        '      return new Response("imported-ok: " + JSON.stringify({ aborted: signal.aborted }));\n' +
        "    } catch (e) {\n" +
        '      return new Response("threw: " + (e && e.message || String(e)));\n' +
        "    }\n" +
        "  }\n" +
        "};\n",
      "helper.js": {
        cjs:
          "module.exports.run = async function () {\n" +
          "  const c = new AbortController();\n" +
          "  return { signal: c.signal };\n" +
          "};\n",
      },
    });
    expect(r.ok).toBe(true);
    expect((r as { ok: true; value: unknown }).value).toContain("imported-ok");
  });

  it("G) dynamic A → static B with top-level I/O in B", async () => {
    const r = await runScenario({
      "page.js":
        "export default {\n" +
        "  async fetch() {\n" +
        "    try {\n" +
        '      const mod = await import("./A.js");\n' +
        '      return new Response("imported-ok: " + JSON.stringify(mod));\n' +
        "    } catch (e) {\n" +
        '      return new Response("threw: " + (e && e.message || String(e)));\n' +
        "    }\n" +
        "  }\n" +
        "};\n",
      "A.js": 'import { okB } from "./B.js";\n' + 'export const okA = "A-loaded, okB=" + okB;\n',
      "B.js":
        "const c = new AbortController();\n" +
        'export const okB = "B-loaded, aborted=" + c.signal.aborted;\n',
    });
    console.log(`[probe G] ok=${r.ok} body=${(r as any).value} err=${(r as any).error}`);
    expect(r).toBeDefined();
  });

  it("I) dynamic-import from fetch() handler — top-level crypto.getRandomValues in imported module", async () => {
    const r = await runScenario({
      "page.js":
        "export default {\n" +
        "  async fetch() {\n" +
        "    try {\n" +
        '      const mod = await import("./helper.js");\n' +
        '      return new Response("imported-ok: " + JSON.stringify({ bytes: mod.bytes.length }));\n' +
        "    } catch (e) {\n" +
        '      return new Response("threw: " + (e && e.message || String(e)));\n' +
        "    }\n" +
        "  }\n" +
        "};\n",
      "helper.js":
        "const buf = new Uint8Array(16);\n" +
        "crypto.getRandomValues(buf);\n" +
        "export const bytes = buf;\n",
    });
    console.log(`[probe I] ok=${r.ok} body=${(r as any).value} err=${(r as any).error}`);
    expect(r).toBeDefined();
  });

  it("J) dynamic-import from fetch() handler — top-level Math.random in imported module", async () => {
    const r = await runScenario({
      "page.js":
        "export default {\n" +
        "  async fetch() {\n" +
        '    const mod = await import("./helper.js");\n' +
        '    return new Response("v=" + (typeof mod.v));\n' +
        "  }\n" +
        "};\n",
      "helper.js": "export const v = Math.random();\n",
    });
    console.log(`[probe J] ok=${r.ok} body=${(r as any).value} err=${(r as any).error}`);
    expect(r).toBeDefined();
  });

  it("K) dynamic import sees handler-set globalThis bindings", async () => {
    const r = await runScenario({
      "page.js":
        "export default {\n" +
        "  async fetch() {\n" +
        '    globalThis.window = { addEventListener: () => "called" };\n' +
        "    try {\n" +
        '      const mod = await import("./helper.js");\n' +
        "      return new Response(JSON.stringify({\n" +
        "        captureType: typeof mod.captured,\n" +
        "        captureIsWindow: mod.captured === globalThis.window,\n" +
        "        callResult: mod.callResult,\n" +
        "      }));\n" +
        "    } catch (e) {\n" +
        '      return new Response("threw: " + (e && e.message || String(e)));\n' +
        "    }\n" +
        "  }\n" +
        "};\n",
      "helper.js":
        'export const captured = typeof window === "undefined" ? null : window;\n' +
        'export const callResult = (typeof window !== "undefined" && window.addEventListener) ? window.addEventListener("x", () => {}) : "no-window";\n',
    });
    console.log(`[probe K] ok=${r.ok} body=${(r as any).value} err=${(r as any).error}`);
    expect(r).toBeDefined();
  });

  it("H) dynamic A → dynamic B with top-level I/O in B", async () => {
    const r = await runScenario({
      "page.js":
        "export default {\n" +
        "  async fetch() {\n" +
        "    try {\n" +
        '      const mod = await import("./A.js");\n' +
        "      const innerB = await mod.loadB();\n" +
        '      return new Response("imported-ok: " + JSON.stringify(innerB));\n' +
        "    } catch (e) {\n" +
        '      return new Response("threw: " + (e && e.message || String(e)));\n' +
        "    }\n" +
        "  }\n" +
        "};\n",
      "A.js":
        "export async function loadB() {\n" +
        '  const m = await import("./B.js");\n' +
        "  return { okB: m.okB };\n" +
        "}\n",
      "B.js":
        "const c = new AbortController();\n" +
        'export const okB = "B-loaded, aborted=" + c.signal.aborted;\n',
    });
    console.log(`[probe H] ok=${r.ok} body=${(r as any).value} err=${(r as any).error}`);
    expect(r).toBeDefined();
  });
});
