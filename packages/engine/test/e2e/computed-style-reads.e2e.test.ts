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

test("elements under display:none report their computed style", async ({ page }) => {
  await setContent(
    page,
    `<style>
    #hidden { display: none; color: rgb(1, 2, 3); --hidden-value: 23px }
    #inner { display: flex; margin-left: 7px }
  </style>
  <div id=hidden><p id=inner>x<b id=bold>y</b></p></div>`,
  );
  const read = await page.evaluate(() => {
    const style = (id: string) => getComputedStyle(document.getElementById(id)!);
    return [
      style("inner").display,
      style("inner").color,
      style("inner").marginLeft,
      style("bold").display,
      style("bold").fontWeight,
      style("inner").getPropertyValue("--hidden-value"),
    ];
  });
  // A flex item is blockified.
  expect(read).toEqual(["flex", "rgb(1, 2, 3)", "7px", "block", "700", "23px"]);
});

test("a subtree hidden after layout lays out the same when shown", async ({ page }) => {
  await setContent(
    page,
    `<div id=outer><div id=block>bare text<p id=para>some <b>bold</b> text</p><ul><li>a</li></ul></div></div>`,
  );
  const rects = await page.evaluate(() => {
    const read = () => {
      const r = document.getElementById("para")!.getBoundingClientRect();
      return [r.x, r.y, r.width, r.height];
    };
    const outer = document.getElementById("outer")!;
    const shown = read();
    outer.style.display = "none";
    const hidden = read();
    const display = getComputedStyle(document.getElementById("para")!).display;
    outer.style.display = "";
    return { shown, hidden, display, again: read() };
  });
  expect(rects.hidden).toEqual([0, 0, 0, 0]);
  expect(rects.display).toBe("block");
  expect(rects.again).toEqual(rects.shown);
  expect(rects.shown[2]).toBeGreaterThan(0);
});

test("pseudo styles resolve under display:none", async ({ page }) => {
  await setContent(
    page,
    `<style>#h{display:none} #c::before{content:"x";color:rgb(4,5,6)}</style>
     <div id=h><span id=c>hidden</span></div>`,
  );
  expect(
    await page.evaluate(() => {
      const child = document.getElementById("c");
      if (!child) throw new Error("missing hidden child");
      return getComputedStyle(child, "::before").color;
    }),
  ).toBe("rgb(4, 5, 6)");
});

test("cousin styles stay distinct under cache pressure and ancestor mutation", async ({ page }) => {
  const groups = 96;
  await setContent(
    page,
    `<style>
      section { color: rgb(1, 2, 3) }
      .hot .leaf { color: rgb(4, 5, 6) }
      .leaf[data-hit] { background-color: rgb(7, 8, 9) }
      .leaf:nth-child(2) { margin-left: 7px }
      section[data-mode=on] .leaf { padding-left: 9px }
      .leaf::before { content: "x"; color: inherit }
    </style>${Array.from(
      { length: groups },
      (_, i) =>
        `<section class="${i % 2 ? "hot" : "cold"}" data-mode="${i % 3 ? "off" : "on"}">
        <div><span class=leaf>x</span><span class=leaf data-hit>x</span><span class=leaf>x</span></div>
      </section>`,
    ).join("")}`,
  );
  const read = () =>
    page.evaluate(() =>
      Array.from(document.querySelectorAll(".leaf"), (element) => {
        const style = getComputedStyle(element);
        return [
          style.color,
          style.backgroundColor,
          style.marginLeft,
          style.paddingLeft,
          getComputedStyle(element, "::before").color,
        ];
      }),
    );
  const expected = (mutated: boolean) =>
    Array.from({ length: groups * 3 }, (_, index) => {
      const group = Math.floor(index / 3);
      const child = index % 3;
      const color = group % 2 || (mutated && group === 0) ? "rgb(4, 5, 6)" : "rgb(1, 2, 3)";
      return [
        color,
        child === 1 ? "rgb(7, 8, 9)" : "rgba(0, 0, 0, 0)",
        child === 1 ? "7px" : "0px",
        group % 3 === 0 && !(mutated && group === 0) ? "9px" : "0px",
        color,
      ];
    });
  expect(await read()).toEqual(expected(false));
  await page.evaluate(() => {
    const first = document.querySelector("section");
    if (!first) throw new Error("missing first cousin group");
    first.className = "hot";
    first.setAttribute("data-mode", "off");
  });
  expect(await read()).toEqual(expected(true));
});
