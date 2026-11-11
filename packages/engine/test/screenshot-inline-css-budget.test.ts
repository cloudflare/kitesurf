// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, it, vi } from "vitest";

// The core wasm cannot run under the Vitest embedder; the inlining sink is the DOM factory.
vi.mock("../src/wasm.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/wasm.ts")>()),
  renderHtmlToImage: () => new Uint8Array([1]),
}));

import type { DispatchCtx } from "../src/cdp/dispatch.ts";
import { setDomFactory } from "../src/cdp/dom-release.ts";
import { handlePage } from "../src/cdp/page.ts";
import { StyleCache } from "../src/cdp/style-cache.ts";
import type { TargetState } from "../src/cdp/types.ts";
import type { DomHandle } from "../src/wasm.ts";

// Reaches the pre-PageScript screenshot fallback: no pageScript, so the retained HTML is reparsed
// through the registered DOM factory and inlineStylesheets runs on the cached sheet.
async function capture(links: number, chars: number): Promise<string[]> {
  const copied: string[] = [];
  let next = links + 1;
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the inlining sink is modelled.
  const dom = {
    querySelectorAll: (selector: string) =>
      selector === "link[rel='stylesheet']"
        ? Int32Array.from({ length: links }, (_, i) => i + 1)
        : new Int32Array(0),
    nodeInfo: () => ({ attributes: ["href", "/x.css"] }),
    createElement: () => next++,
    applyOps: () => {},
    createTextNode: (text: string) => {
      copied.push(text);
      return next++;
    },
    appendChildNode: () => {},
    replaceChildNode: () => {},
    removeNode: () => {},
  } as unknown as DomHandle;
  setDomFactory(() => dom);
  const cache = new StyleCache();
  cache.set("https://page.test/x.css", { css: "a".repeat(chars), fetchedAt: Date.now() });
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fallback fields are set.
  const target = {
    type: "page",
    targetId: "T",
    frameId: "F",
    url: "https://page.test/index.html",
    html: "<html></html>",
    dom: null,
    domEpoch: 0,
  } as unknown as TargetState;
  // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- only the fallback fields are set.
  const ctx = {
    browser: {
      targets: new Map([["T", target]]),
      styleCache: cache,
      sandboxOutbound: { parent: () => ({ fetch: () => Promise.reject(new Error("cached")) }) },
    },
    connectionId: "inline-css-budget",
  } as unknown as DispatchCtx;
  await handlePage(ctx, { id: 1, method: "Page.captureScreenshot", params: {} });
  return copied;
}

it("drops cached duplicate links once the aggregate budget is spent", async () => {
  // Two bytes per UTF-16 code unit: four 1 MiB copies fit the 8 MiB budget, the fifth does not.
  expect(await capture(5, 1024 * 1024)).toHaveLength(4);
});
