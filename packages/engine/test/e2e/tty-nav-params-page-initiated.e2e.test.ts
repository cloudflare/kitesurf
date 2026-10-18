// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const TARGET = "https://ks.invalid/__fixtures/events.html?ks_color_scheme=dark";

const isDark = () => matchMedia("(prefers-color-scheme: dark)").matches;

test("a page-initiated navigation cannot set the session's tty flags", async ({
  browser,
  page,
}) => {
  await setContent(page, `<a id=l href="${TARGET}" style="font-size:40px">go</a>`);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10_000 }),
    page.click("#l"),
  ]);
  expect(await page.evaluate(isDark)).toBe(false);
  expect(await page.evaluate(() => location.search)).toBe("?ks_color_scheme=dark");

  await setContent(page, "<p>x</p>");
  await page
    .evaluate((u: string) => {
      location.href = u;
    }, TARGET)
    .catch(() => {});
  await page.waitForFunction(() => location.pathname === "/__fixtures/events.html", {
    timeout: 15_000,
  });
  expect(await page.evaluate(isDark)).toBe(false);
  expect(await page.evaluate(() => location.search)).toBe("?ks_color_scheme=dark");

  const other = await browser.newPage();
  await setContent(other, "<p>x</p>");
  expect(await other.evaluate(isDark)).toBe(false);

  await page.goto(TARGET, { waitUntil: "domcontentloaded" });
  expect(await page.evaluate(isDark)).toBe(true);
  expect(await page.evaluate(() => location.search)).toBe("");
}, 120_000);
