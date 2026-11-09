// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const OFF_POLICY = "https://ks-other.invalid/__fixtures/inserted-ok.js";

test("script-src applies to the target of a script's redirect", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html>
    <meta http-equiv="Content-Security-Policy" content="script-src https://ks.invalid">
    <title>start</title>
    <script src="https://ks.invalid/__fixtures/loud-redirect?to=${encodeURIComponent(OFF_POLICY)}"></script>`,
  );
  expect(await page.evaluate(() => Reflect.get(window, "__insertedRan") ?? false)).toBe(false);
});

test("a script that redirects within script-src still runs", async ({ page }) => {
  const allowed = "https://ks.invalid/__fixtures/inserted-ok.js";
  await setContent(
    page,
    `<!doctype html>
    <meta http-equiv="Content-Security-Policy" content="script-src https://ks.invalid">
    <title>start</title>
    <script src="https://ks.invalid/__fixtures/loud-redirect?to=${encodeURIComponent(allowed)}"></script>`,
  );
  expect(await page.evaluate(() => Reflect.get(window, "__insertedRan") ?? false)).toBe(true);
});
