// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { it, expect, vi } from "vitest";

import { prefetchWasmModules, scanForWasmUrls } from "../src/eval/prefetch-wasm.ts";

const MIB = 1024 * 1024;

function wasmModule(size: number): Uint8Array {
  // Header plus repeated empty custom sections, so the bytes validate.
  const bytes = new Uint8Array(size - ((size - 8) % 3));
  bytes.set([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  for (let i = 8; i < bytes.length; i += 3) bytes[i + 1] = 0x01;
  return bytes;
}

const miss = async () => new Response(null, { status: 404 });
function stubOutbound(routes: Record<string, () => Response>) {
  const fetcher = { fetch: async (req: Request) => routes[req.url]?.() ?? miss() } as Fetcher;
  const base = { external: false, parent: () => fetcher, loaded: () => fetcher };
  return { ...base, session: () => miss, final: miss };
}

it("bounds concurrent wasm prefetch memory", async () => {
  const a = wasmModule(30 * MIB),
    b = wasmModule(30 * MIB);
  const slow = new ReadableStream<Uint8Array>({
    async pull(c) {
      await new Promise((r) => setTimeout(r, 0)); // let the sibling read finish first
      c.enqueue(b);
      c.close();
    },
  });
  const bake = await prefetchWasmModules({
    urls: ["https://site.test/a.wasm", "https://site.test/b.wasm", "https://site.test/c.wasm"],
    pageUrl: "https://site.test/page",
    connectionId: "conn",
    cookieKey: "jar",
    sandboxOutbound: stubOutbound({
      "https://site.test/a.wasm": () => new Response(a),
      "https://site.test/b.wasm": () => new Response(slow),
      "https://site.test/c.wasm": () =>
        new Response("x".repeat(8 * 1024), {
          status: 403,
          headers: { "x-kitesurf-blocked": "policy" },
        }),
    }),
  });
  const retained = Object.values(bake.modules).reduce((n, m) => n + m.byteLength, 0);
  expect(retained).toBeLessThanOrEqual(48 * MIB);
  expect((bake.errors["https://site.test/c.wasm"] ?? "").length).toBeLessThanOrEqual(4 * 1024);
});

it("bounds wasm literal url resolution", () => {
  const longBase = "https://site.test/" + "d/".repeat(30_000);
  const repUrl = longBase + "m.wasm";
  const lit = 'WebAssembly.instantiate("m.wasm");';
  const unique = Array.from({ length: 300 }, (_, i) => `WebAssembly.instantiate("m${i}.wasm");`);
  const rows = [
    { name: "repeated", sources: [{ body: lit.repeat(300), baseUrl: longBase }], urls: [repUrl] },
    {
      name: "two bases",
      sources: [
        { body: lit, baseUrl: "https://site.test/x/" },
        { body: lit, baseUrl: "https://site.test/y/" },
      ],
      urls: ["https://site.test/x/m.wasm", "https://site.test/y/m.wasm"],
    },
    { name: "unique", sources: [{ body: unique.join(""), baseUrl: "" }], urls: [] },
  ];
  let resolutions = 0;
  vi.stubGlobal(
    "URL",
    new Proxy(URL, {
      construct: (target, args) => {
        resolutions++;
        return Reflect.construct(target, args);
      },
    }),
  );
  try {
    for (const row of rows) {
      resolutions = 0;
      expect(scanForWasmUrls(row.sources), row.name).toEqual(row.urls);
      expect(resolutions, row.name).toBeLessThanOrEqual(256);
    }
  } finally {
    vi.unstubAllGlobals();
  }
});
