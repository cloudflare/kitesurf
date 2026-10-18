// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// navigator.userAgentData must agree with the User-Agent string, and only Chromium has it.

import type { Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const CHROME_LINUX_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7000.12 Safari/537.36";

function readUserAgentData(page: Page) {
  return page.evaluate(async () => {
    const data: unknown = Reflect.get(navigator, "userAgentData");
    if (typeof data !== "object" || data === null) return null;
    const getHigh: unknown = Reflect.get(data, "getHighEntropyValues");
    const high =
      typeof getHigh === "function"
        ? await Reflect.apply(getHigh, data, [["uaFullVersion", "architecture"]])
        : null;
    return {
      brands: Reflect.get(data, "brands"),
      mobile: Reflect.get(data, "mobile"),
      platform: Reflect.get(data, "platform"),
      high,
    };
  });
}

test("a Chrome UA override gets matching userAgentData", async ({ page }) => {
  await page.setUserAgent(CHROME_LINUX_UA);
  await setContent(page, "<p>ua</p>");
  expect(await page.evaluate(() => navigator.userAgent)).toBe(CHROME_LINUX_UA);
  const got = await readUserAgentData(page);
  expect(got).toMatchObject({ mobile: false, platform: "Linux" });
  expect(got?.brands).toContainEqual({ brand: "Chromium", version: "151" });
  expect(got?.high).toMatchObject({ uaFullVersion: "151.0.7000.12", architecture: "x86" });
});

test("a non-Chromium UA has no userAgentData", async ({ page }) => {
  await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0");
  await setContent(page, "<p>ua</p>");
  expect(await page.evaluate(() => navigator.userAgent)).toContain("Firefox/140.0");
  expect(await page.evaluate(() => "userAgentData" in navigator)).toBe(false);
});

test("the engine's own default UA has no userAgentData", async ({ page }) => {
  await setContent(page, "<p>ua</p>");
  expect(await page.evaluate(() => navigator.userAgent)).not.toContain("Chrome/");
  expect(await readUserAgentData(page)).toBeNull();
});
