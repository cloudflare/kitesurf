// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { decodePng, sample, near } from "./png";

test("oopif-worker-budget", async ({ page, cdpSession }) => {
  const childContexts: number[] = [];
  cdpSession.on("Runtime.executionContextCreated", (p) => {
    if (p.context.origin === "http://127.0.0.1:8787") {
      childContexts.push(p.context.id);
    }
  });
  await cdpSession.send("Runtime.enable");
  await cdpSession.send("Page.enable");
  await page.goto("http://localhost:8787/__fixtures/oopif-host-budget.html", {
    waitUntil: "load",
    timeout: 60000,
  });

  await expect
    .poll(() => childContexts.length, { timeout: 15_000 })
    .toBeGreaterThan(0)
    .catch(() => {});
  expect(childContexts.length, "the first cross-origin iframe must get a child isolate").toBe(1);

  await new Promise((r) => setTimeout(r, 1500));
  const shot = decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  expect(childContexts.length, "the second iframe must be denied — one OOPIF per connection").toBe(
    1,
  );

  const first = sample(shot, 170, 120);
  const second = sample(shot, 170, 340);
  expect(
    near(first, [255, 0, 0]),
    `first iframe should paint red; got rgb(${first.join(",")})`,
  ).toBe(true);
  expect(
    near(second, [255, 255, 255]),
    `blocked iframe must render blank, not blue; got rgb(${second.join(",")})`,
  ).toBe(true);

  await cdpSession.send("Runtime.evaluate", {
    expression: "document.getElementById('first').remove(); 'removed'",
    returnByValue: true,
  });
  let blue: [number, number, number] = [255, 255, 255];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const png = decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
    blue = sample(png, 170, 120);
    if (near(blue, [0, 0, 255])) break;
  }
  expect(
    near(blue, [0, 0, 255]),
    `freed slot must let the blocked iframe spawn; got rgb(${blue.join(",")})`,
  ).toBe(true);
});
