// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Protocol } from "devtools-protocol";
import { expect, test } from "../harness";

test("events-demo", async ({ page }) => {
  const FIXTURE_URL =
    process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/events.html";

  const expectedPath = [
    "window:capture",
    "btn:target",
    "btn:once",
    "btn:preventDefault",
    "body:bubble",
    "window:bubble",
    "target=btn",
  ];

  await page.goto(FIXTURE_URL, { timeout: 15000 });

  await page.evaluate(() => {
    globalThis.__ks_path = [];
    globalThis.__ks_clickBtn();
  });
  const after1 = await page.evaluate(() => ({
    path: globalThis.__ks_path,
    counter: document.querySelector("#counter").textContent,
  }));
  expect(after1.path, "el.click()").toStrictEqual(expectedPath);
  expect(after1.counter, "counter after click 1").toBe("1");

  const btnRect = await page.evaluate(() => {
    globalThis.__ks_path = [];
    const r = document.querySelector("#btn").getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  expect(
    btnRect.width > 0 && btnRect.height > 0,
    `button has non-zero rect (layout resolved): ${JSON.stringify(btnRect)}`,
  ).toBeTruthy();
  const session = await page.target().createCDPSession();
  await session.send("Input.dispatchMouseEvent", {
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- input.ts maps click.
    type: "click" as unknown as Protocol.Input.DispatchMouseEventRequest["type"],
    x: btnRect.x + btnRect.width / 2,
    y: btnRect.y + btnRect.height / 2,
    button: "left",
    clickCount: 1,
  });

  const path2 = await page.evaluate(() => globalThis.__ks_path);

  const expectedCdpPath = [
    "window:capture",
    "btn:target",
    "btn:preventDefault",
    "body:bubble",
    "window:bubble",
    "target=btn",
  ];
  expect(path2, "CDP dispatchMouseEvent path").toStrictEqual(expectedCdpPath);

  await page.evaluate(() => {
    globalThis.__ks_path = [];
    globalThis.__ks_clickBtn();
  });
  const path3 = await page.evaluate(() => globalThis.__ks_path);
  const expectedPath3 = [
    "window:capture",
    "btn:target",
    "btn:preventDefault",
    "body:bubble",
    "window:bubble",
    "target=btn",
  ];
  expect(path3.length, "second-click path length").toBe(expectedPath3.length);
  expect(path3.includes("btn:once"), "{once:true} listener fired again").toBe(false);
});
