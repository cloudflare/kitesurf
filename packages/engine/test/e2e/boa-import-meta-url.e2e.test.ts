// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const ORIGIN = "http://127.0.0.1:8787";
const CHUNK = `${ORIGIN}/__fixtures/importmeta-chunk.js`;

test("boa loader sets import.meta.url", async ({ page }) => {
  await page.goto(`${ORIGIN}/__fixtures/dynimport.html`, {
    waitUntil: "load",
    timeout: 30000,
  });

  const meta = await page.evaluate(`import(${JSON.stringify(CHUNK)}).then(m => m.metaUrl)`);
  expect(meta, "import.meta.url is the module's own absolute URL").toBe(CHUNK);

  const asset = await page.evaluate(`import(${JSON.stringify(CHUNK)}).then(m => m.assetUrl)`);
  expect(asset, "new URL(rel, import.meta.url) resolves").toBe(
    `${ORIGIN}/__fixtures/importmeta-asset.png`,
  );
});

test("boa loader sets import.meta.resolve", async ({ page }) => {
  await page.goto(`${ORIGIN}/__fixtures/dynimport.html`, {
    waitUntil: "load",
    timeout: 30000,
  });

  const resolved = await page.evaluate(
    `import(${JSON.stringify(CHUNK)}).then(m => [m.resolvedUrl, m.bareError])`,
  );
  expect(resolved, "relative resolves against the module; bare throws").toEqual([
    `${ORIGIN}/__fixtures/importmeta-asset.png`,
    "TypeError",
  ]);
});
