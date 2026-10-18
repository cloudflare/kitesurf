// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Browser, Page } from "@cloudflare/puppeteer";

import { readEngineMemory } from "./cdp-read";
import { expect, test } from "./harness";
import { waitForTitle } from "./waits";

const HOST = "https://ks.invalid/__fixtures/webfont.html";

interface FontLoad {
  wf: number;
  fallback: number;
  retainedCount: number;
  retainedBytes: number;
}

async function retained(page: Page): Promise<{ count: number; bytes: number }> {
  const session = await page.createCDPSession();
  const mem = await readEngineMemory(session);
  return { count: mem.retainedImageCount, bytes: mem.retainedImageBytes };
}

async function loadWebfont(browser: Browser): Promise<FontLoad> {
  const page = await browser.newPage();
  const before = await retained(page);
  await page.goto(HOST, { waitUntil: "load", timeout: 30000 });
  const title = await waitForTitle(page, "FONTSETTLED", { timeout: 20_000 });
  if (title !== "FONTSETTLED") {
    throw new Error("fixture never settled");
  }
  const raw: unknown = await page.evaluate(`(() => {
    const w = (id) => document.getElementById(id).getBoundingClientRect().width;
    return { wf: w("wf"), fallback: w("fallback") };
  })()`);
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`width probe returned ${typeof raw}`);
  }
  const num = (key: string): number => {
    const v: unknown = Reflect.get(raw, key);
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`${key}: expected a number, got ${String(v)}`);
    }
    return v;
  };
  const after = await retained(page);
  return {
    wf: num("wf"),
    fallback: num("fallback"),
    retainedCount: after.count - before.count,
    retainedBytes: after.bytes - before.bytes,
  };
}

test("a pixel-free session retains nothing: the face is substituted, not kept", async ({
  browserFactory,
}) => {
  const browser = await browserFactory({
    headers: { "x-kitesurf-skip-raster": "1" },
  });
  const r = await loadWebfont(browser);
  expect(r.wf).toBeGreaterThan(r.fallback * 1.1);
  expect(r.retainedCount).toBe(0);
  expect(r.retainedBytes).toBe(0);
});

test("a paint session keeps the full face for the renderer to pull", async ({ browser }) => {
  const r = await loadWebfont(browser);
  expect(r.wf).toBeGreaterThan(r.fallback * 1.1);
  expect(r.retainedCount).toBe(1);
  expect(r.retainedBytes).toBeGreaterThan(1000);
});
