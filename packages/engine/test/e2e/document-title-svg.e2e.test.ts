// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("an inline svg's <title> never names the document", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><head><title>Real title</title></head><body>
    <div id=box></div><svg><title>Icon</title></svg>
    <script>document.getElementById("box").appendChild(document.querySelector("head > title"));</script>`,
  );
  expect(await page.evaluate(() => document.title)).toBe("Real title");
  await page.evaluate(() => {
    document.title = "Renamed";
  });
  expect(
    await page.evaluate(() => [document.title, document.querySelector("svg title")?.textContent]),
  ).toEqual(["Renamed", "Icon"]);
}, 60_000);

test("a standalone svg document takes its title from the root svg", async ({ page }) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><title>Logo</title><rect width="10" height="10"/></svg>`;
  await page.goto(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, {
    waitUntil: "load",
  });
  expect(await page.evaluate(() => document.title)).toBe("Logo");
  expect(
    await page.evaluate(
      () =>
        new DOMParser().parseFromString(
          `<svg xmlns="http://www.w3.org/2000/svg"><title>Parsed</title></svg>`,
          "image/svg+xml",
        ).title,
    ),
  ).toBe("Parsed");
}, 60_000);
