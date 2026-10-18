// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

import { readChildFrameCount, readEngineMemory } from "./cdp-read";

test("repeated multi-iframe navigates keep engine wasm bounded", async ({ page, cdpSession }) => {
  const NAVIGATES = 8;
  const FRAMES_PER_DOC = 12;
  for (let i = 0; i < NAVIGATES; i++) {
    await page.goto(
      `http://localhost:8787/__fixtures/iframe-many.html?k=${FRAMES_PER_DOC}&seed=${i}`,
      { waitUntil: "load", timeout: 120000 },
    );
    expect(page.frames().length).toBe(FRAMES_PER_DOC + 1);
  }

  const mem = await readEngineMemory(cdpSession);
  expect(
    mem.wasmDeltaBytes,
    `engine wasm grew ${mem.wasmDeltaBytes} bytes over ` +
      `${NAVIGATES} navigates x ${FRAMES_PER_DOC} in-process iframes`,
  ).toBeLessThan(24 * 1024 * 1024);
});

test("a detached iframe keeps its frame entry", async ({ page, cdpSession }) => {
  await page.goto("http://localhost:8787/__fixtures/iframe-reinsert.html", {
    waitUntil: "load",
    timeout: 120000,
  });

  expect(await readChildFrameCount(cdpSession)).toBe(1);

  const detachedFrames: string[] = [];
  cdpSession.on("Page.frameDetached", (p) => {
    detachedFrames.push(p.frameId);
  });

  await page.evaluate("document.getElementById('f').remove()");
  await expect.poll(() => detachedFrames.length, { timeout: 10_000 }).toBeGreaterThan(0);

  expect(
    await readChildFrameCount(cdpSession),
    "the detached child remains in Page.getFrameTree",
  ).toBe(1);
});

test.skip("a reinserted detached iframe remains in the frame tree", async ({ page }) => {
  await page.goto("http://localhost:8787/__fixtures/iframe-reinsert.html", {
    waitUntil: "load",
    timeout: 120000,
  });
  expect(page.frames().length).toBe(2);
  expect(await page.evaluate("window.__reinsert()")).toBe("reinserted");
  await new Promise((r) => setTimeout(r, 1000));
  expect(page.frames().length).toBe(2);
});
