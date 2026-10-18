// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const READ = `[typeof document.referrer, document.referrer]`;

test("document.referrer is an empty string when no referrer was sent", async ({ page }) => {
  await setContent(
    page,
    `<script>globalThis.__classic = ${READ};</script>` +
      `<script type="module">globalThis.__module = ${READ};</script>`,
  );
  await page.waitForFunction("globalThis.__module !== undefined", { timeout: 10_000 });
  expect(await page.evaluate("globalThis.__classic")).toEqual(["string", ""]);
  expect(await page.evaluate("globalThis.__module")).toEqual(["string", ""]);
});

test("document.referrer reports the goto referer", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/navigation-landing.html", {
    referer: "https://www.google.com/",
    waitUntil: "load",
  });
  expect(await page.evaluate("document.referrer")).toBe("https://www.google.com/");

  await page.goto("https://ks.invalid/__fixtures/navigation-landing.html", { waitUntil: "load" });
  expect(await page.evaluate("document.referrer")).toBe("");
});
