// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";
import { expect } from "vitest";

import { test } from "./harness";
import { setContent } from "./set-content";
import { targetIdForSession } from "./connect";

async function prepares(page: Page): Promise<number> {
  const session = await page.createCDPSession();
  const targetId = await targetIdForSession(session);
  const s = await session.send("Kitesurf.getMemoryStats", { targetId });
  await session.detach().catch(() => {});
  if (typeof s?.paint?.prepares !== "number")
    throw new Error(`no paint stats in ${JSON.stringify(s).slice(0, 200)}`);
  return s.paint.prepares;
}

test("moving the selection does not re-run the cascade", async ({ page }) => {
  await setContent(page, `<div id=ed contenteditable><p id=p>abcdef</p></div>`);
  await page.evaluate(() => {
    getComputedStyle(document.getElementById("p")!).display;
  });
  const before = await prepares(page);
  const display = await page.evaluate(() => {
    const p = document.getElementById("p")!;
    const text = p.firstChild!;
    let out = "";
    for (let i = 0; i < 20; i++) {
      getSelection()!.collapse(text, i % 6);
      out = getComputedStyle(p).display;
    }
    return out;
  });
  expect(display).toBe("block");
  expect(await prepares(page)).toBe(before);
});

test("a single-property read matches the full declaration", async ({ page }) => {
  await setContent(
    page,
    `<style>
    #flex { display: flex; width: 400px; color: rgb(10, 20, 30) }
    #item { width: 50%; margin: 5% auto; padding: 2%; border: 1px solid currentcolor; text-decoration: underline }
    #sticky { position: sticky; top: 10px; transform-origin: 20% 30% }
    #hidden { display: none }
    #grid { display: grid; grid-template-columns: 1fr 2fr; width: 300px }
  </style>
  <div id=flex><span id=item>item</span><div id=sticky>sticky</div></div>
  <div id=hidden><b id=inner>x</b></div>
  <div id=grid><i>a</i><i>b</i></div>
  <p id=para style="white-space: pre-wrap; font-weight: 700">text</p>`,
  );
  const mismatches = await page.evaluate(() => {
    const out: string[] = [];
    for (const id of ["flex", "item", "sticky", "hidden", "inner", "grid", "para"]) {
      const el = document.getElementById(id)!;
      const full = getComputedStyle(el);
      for (const name of Array.from(full)) {
        const want = full.getPropertyValue(name);
        const kebab = getComputedStyle(el).getPropertyValue(name);
        const camelName = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
        const camel = Reflect.get(getComputedStyle(el), camelName);
        if (kebab !== want)
          out.push(`${id} ${name}: ${JSON.stringify(kebab)} != ${JSON.stringify(want)}`);
        if (!name.startsWith("-") && camel !== want)
          out.push(`${id} ${name} (camel): ${JSON.stringify(camel)} != ${JSON.stringify(want)}`);
      }
    }
    return out;
  });
  expect(mismatches).toEqual([]);
});
