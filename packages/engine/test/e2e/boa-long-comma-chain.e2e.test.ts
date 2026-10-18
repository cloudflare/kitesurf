// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Generated data modules can be one statement of thousands of comma-joined calls; its left-leaning
// tree overran the wasm stack in every recursive pass until long chains balanced.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("thousands of comma-joined calls run on boa, in order", async ({ page }) => {
  await setContent(page, "<!doctype html><title>t</title>");
  const n = 5000;
  const chain = Array.from({ length: n }, (_, i) => `f(${i})`).join(",");
  const result = await page.evaluate(
    `(() => { const seen = []; const f = (v) => { seen.push(v); return v; }; const last = (${chain}); ` +
      `return [seen.length, seen.every((v, i) => v === i), last]; })()`,
  );
  expect(result).toEqual([n, true, n - 1]);
}, 60_000);
