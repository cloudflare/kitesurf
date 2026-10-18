// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

import { readEngineMemory } from "./cdp-read";

const ROWS = 6000;
const MAX_ENGINE_WASM_GROWTH_BYTES = 8 * 1024 * 1024;

function bigDoc(seed: number): string {
  return `http://localhost:8787/__fixtures/big-doc.html?rows=${ROWS}&seed=${seed}`;
}

test("repeated navigates of a large document keep engine wasm bounded", async ({
  page,
  cdpSession,
}) => {
  await page.goto(bigDoc(0), { waitUntil: "load", timeout: 120000 });
  expect(await page.title()).toBe("big-doc 0");
  const before = await readEngineMemory(cdpSession);

  const MORE = 5;
  for (let i = 1; i <= MORE; i++) {
    await page.goto(bigDoc(i), { waitUntil: "load", timeout: 120000 });
    expect(await page.title()).toBe(`big-doc ${i}`);
  }

  const after = await readEngineMemory(cdpSession);
  const grew = after.wasmBytes - before.wasmBytes;
  expect(
    grew,
    `engine wasm grew ${grew} bytes over ${MORE} further navigates of a ` +
      `${ROWS}-row document (floor was ${before.wasmBytes})`,
  ).toBeLessThan(MAX_ENGINE_WASM_GROWTH_BYTES);
});

test("concurrent targets don't each pin a resident parse", async ({
  browser,
  page,
  cdpSession,
}) => {
  await page.goto(bigDoc(100), { waitUntil: "load", timeout: 120000 });
  const before = await readEngineMemory(cdpSession);

  const MORE = 3;
  for (let i = 1; i <= MORE; i++) {
    const extra = await browser.newPage();
    await extra.goto(bigDoc(100 + i), { waitUntil: "load", timeout: 120000 });
    expect(await extra.title()).toBe(`big-doc ${100 + i}`);
  }

  const after = await readEngineMemory(cdpSession);
  const grew = after.wasmBytes - before.wasmBytes;
  expect(
    grew,
    `engine wasm grew ${grew} bytes across ${MORE} concurrent big-doc ` +
      `targets (floor was ${before.wasmBytes})`,
  ).toBeLessThan(MAX_ENGINE_WASM_GROWTH_BYTES);
});
