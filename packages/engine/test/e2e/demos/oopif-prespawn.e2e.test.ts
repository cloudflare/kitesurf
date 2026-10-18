// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { decodePng, sample, near } from "./png";

test("oopif-prespawn: the budget grants one frame and the rest stay blank", async ({ browser }) => {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.goto("http://localhost:8787/__fixtures/oopif-host-many.html?k=5", {
    waitUntil: "load",
    timeout: 60000,
  });

  const png = decodePng(new Uint8Array(await page.screenshot({ type: "png" })));

  const first = sample(png, 50, 50);
  expect(
    near(first, [255, 0, 0]),
    `frame 1 owns the only slot and must paint red; got rgb(${first.join(",")})`,
  ).toBe(true);

  const blanks: Array<[string, number]> = [
    ["frame 2 (green)", 150],
    ["frame 3 (blue)", 250],
    ["frame 4 (yellow)", 350],
    ["frame 5 (magenta)", 450],
  ];
  for (const [label, y] of blanks) {
    const got = sample(png, 50, y);
    expect(
      near(got, [255, 255, 255]),
      `${label} is over budget and must render blank; got rgb(${got.join(",")})`,
    ).toBe(true);
  }
});

test("oopif-prespawn: the granted frame repaints across a re-navigate", async ({ browser }) => {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  const url = "http://localhost:8787/__fixtures/oopif-host-many.html?k=4";
  await page.goto(url, { waitUntil: "load", timeout: 60000 });
  await page.goto("http://localhost:8787/__fixtures/oopif-host.html", {
    waitUntil: "load",
    timeout: 60000,
  });
  await page.goto(url, { waitUntil: "load", timeout: 60000 });

  const png = decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  const got = sample(png, 50, 50);
  expect(
    near(got, [255, 0, 0]),
    `frame 1 must repaint red after the re-navigate; got rgb(${got.join(",")})`,
  ).toBe(true);
});
