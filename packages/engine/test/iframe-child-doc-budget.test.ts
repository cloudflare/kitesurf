// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Same-origin iframe fan-out, or near-cap child documents, must not retain unbounded DOM parses.
import { expect, it, vi } from "vitest";

const { parses, cfg, TEMPLATE } = vi.hoisted(() => ({
  parses: { urls: [] as string[], bytes: 0 },
  cfg: { mode: "fanout" as "fanout" | "large" },
  TEMPLATE: '<iframe src="a/"></iframe>'.repeat(2),
}));

// Two reads fit the 24 MiB per-connection cap; together they exceed one 16 MiB document.
const LARGE_DOC = new Uint8Array(9 * 1024 * 1024).fill(0x61);

const fetchFake = async (input: RequestInfo | URL) => {
  const href = input instanceof Request ? input.url : String(input);
  const body = cfg.mode === "large" && href.endsWith(".html") ? LARGE_DOC : TEMPLATE;
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
};

vi.mock("../src/wasm.ts", () => ({
  scanDocument: () => ({
    iframes: [0, 1].map((i) => ({ src: cfg.mode === "fanout" ? "a/" : `big${i}.html` })),
  }),
  createDom: (html: string, url: string) => {
    parses.urls.push(url);
    parses.bytes += html.length;
    return {
      querySelectorAll: () => (cfg.mode === "fanout" ? Int32Array.of(1, 2) : new Int32Array()),
      nodeInfo: () => ({ attributes: ["src", "a/"] }),
    };
  },
}));

vi.mock("../src/eval/page-script.ts", () => ({
  originOf: (url: string) => new URL(url).origin,
  getOrCreatePageScript: () => {
    throw new Error("no PageScript isolate");
  },
}));

import { handlePage } from "../src/cdp/page.ts";
import { createPageTarget } from "../src/cdp/target.ts";
import { MAX_DOCUMENT_BYTES } from "../src/read-capped.ts";
import type { DispatchCtx } from "../src/cdp/dispatch.ts";

function stub<T>(fields: Record<string, unknown> = {}): T {
  const proxy = new Proxy(() => stub<T>(), {
    get(_t, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return prop in fields ? fields[prop] : stub<T>();
    },
    apply: () => stub<T>(),
  });
  return proxy as T;
}

async function navigate(mode: "fanout" | "large", url: string): Promise<void> {
  cfg.mode = mode;
  parses.urls.length = 0;
  parses.bytes = 0;
  const browser = stub({
    targets: new Map(),
    sandboxOutbound: { parent: () => ({ fetch: fetchFake }) },
    cdpDebug: false,
    wsClosing: false,
  });
  const ctx = stub<DispatchCtx>({ browser, env: {} });
  const target = createPageTarget(ctx, "about:blank");
  const nav = { id: 1, method: "Page.navigate", params: { url }, sessionId: "S1" } as never;
  await handlePage(ctx, nav).catch(() => {});
  const pending = [...target.frames.values()].map((f) => f.pendingLoad).filter((p) => p != null);
  await Promise.all(pending.map((p) => p.catch(() => {})));
}

it("caps parent-side iframe document parses per navigation", async () => {
  await navigate("fanout", "https://attacker.example/a/");
  expect(parses.urls.length).toBe(256);
}, 120_000);

it("caps parent-side iframe parsed bytes per navigation", async () => {
  await navigate("large", "https://attacker.example/");
  expect(parses.urls.length).toBeGreaterThanOrEqual(1);
  expect(parses.bytes).toBeLessThanOrEqual(MAX_DOCUMENT_BYTES);
}, 120_000);
