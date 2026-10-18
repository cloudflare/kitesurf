// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const LIGHT = "rgb(1, 2, 3)";
const DARK = "rgb(9, 8, 7)";

test("light-dark() resolves against the used color-scheme", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/events.html", {
    waitUntil: "domcontentloaded",
  });

  const read = () =>
    page.evaluate(() => {
      const bg = (id: string) => getComputedStyle(document.getElementById(id)!).backgroundColor;
      return {
        dark: bg("cs-dark"),
        light: bg("cs-light"),
        normal: bg("cs-normal"),
        inherited: bg("cs-inherited"),
        themed: bg("cs-themed"),
      };
    });

  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = `
      .ld { background-color: light-dark(rgb(1,2,3), rgb(9,8,7)); }
      #cs-dark { color-scheme: dark; }
      #cs-light { color-scheme: light; }
      #cs-normal { color-scheme: normal; }
      #cs-host { color-scheme: dark; }
      [data-theme="dark"] #cs-themed { color-scheme: dark; }
    `;
    document.head.appendChild(style);
    const host = document.createElement("div");
    host.id = "cs-host";
    document.body.appendChild(host);
    for (const [id, parent] of [
      ["cs-dark", document.body],
      ["cs-light", document.body],
      ["cs-normal", document.body],
      ["cs-inherited", host],
      ["cs-themed", document.body],
    ] as [string, HTMLElement][]) {
      const d = document.createElement("div");
      d.id = id;
      d.className = "ld";
      parent.appendChild(d);
    }
  });

  const before = await read();
  expect(before).toEqual({
    dark: DARK,
    light: LIGHT,
    normal: LIGHT,
    inherited: DARK,
    themed: LIGHT,
  });

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  expect((await read()).themed).toBe(DARK);

  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  expect((await read()).themed).toBe(LIGHT);
}, 120_000);
