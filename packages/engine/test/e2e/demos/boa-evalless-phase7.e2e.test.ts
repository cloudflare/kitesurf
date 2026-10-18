// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("boa-evalless-phase7", async ({ page }) => {
  const session = await page.target().createCDPSession();
  await session.send("Page.enable");
  await session.send("Page.setDocumentContent", {
    frameId: "main",
    html: "<!doctype html><title>p7</title><body><p>a</p><p>b</p><p>c</p></body>",
  });

  expect(await page.evaluate(() => 1 + 1), "() => 1+1").toStrictEqual(2);
  expect(await page.evaluate(() => "abc".toUpperCase()), "string method").toStrictEqual("ABC");
  expect(await page.evaluate((a, b) => a + b, 20, 22), "(a,b) => a+b with args").toStrictEqual(42);
  expect(await page.evaluate(() => [1, 2, 3].map((x) => x * 2)), "array map").toStrictEqual([
    2, 4, 6,
  ]);
  expect(
    await page.evaluate((o) => o.a + o.b.length, { a: 10, b: [1, 2, 3] }),
    "object arg by value",
  ).toStrictEqual(13);
  expect(await page.evaluate(() => ({ x: 1, y: [2, 3] })), "returns object by value").toStrictEqual(
    {
      x: 1,
      y: [2, 3],
    },
  );

  expect(await page.evaluate(() => document.title), "document.title").toStrictEqual("p7");
  expect(
    await page.evaluate(() => document.querySelectorAll("p").length),
    "querySelectorAll length",
  ).toStrictEqual(3);
  expect(
    await page.evaluate(() =>
      Array.from(document.querySelectorAll("p"))
        .map((e) => e.textContent)
        .join(""),
    ),
    "map tagNames via bridge",
  ).toStrictEqual("abc");

  expect(
    await page.evaluate(() => {
      const p = document.querySelector("p");
      p.setAttribute("data-k", "v");
      return document.querySelector("p").getAttribute("data-k");
    }),
    "mutate then read",
  ).toStrictEqual("v");

  await expect(
    page.evaluate(() => {
      throw new Error("kaboom");
    }),
    "throw rejects page.evaluate",
  ).rejects.toThrow();
});
