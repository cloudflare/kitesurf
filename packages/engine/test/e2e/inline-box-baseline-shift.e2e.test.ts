// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { setContent } from "./set-content";
import { expect, test } from "./harness";

const box = (id: string, verticalAlign?: string) =>
  `<span id="${id}" style="display:inline-block;width:10px;height:10px${
    verticalAlign ? `;vertical-align:${verticalAlign}` : ""
  }"></span>`;

test("an inline-block's baseline-shift moves it off the baseline and grows the line", async ({
  page,
}) => {
  await setContent(
    page,
    `<body style="margin:0;font:20px/30px sans-serif">
    <div>${box("ref")}${box("len", "6px")}${box("pct", "20%")}${box("sup", "super")}${box("sub", "sub")}${box("neg", "-4px")}</div>
    <div id="flat" style="line-height:20px">x<span style="display:inline-block">2</span></div>
    <div id="raised" style="line-height:20px">x<span style="display:inline-block;vertical-align:30px">2</span></div>
    <div id="lowered" style="line-height:20px">x<span style="display:inline-block;vertical-align:-30px">2</span></div>`,
  );

  const got = await page.evaluate(() => {
    const rect = (id: string) => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`missing element #${id}`);
      return el.getBoundingClientRect();
    };
    const ref = rect("ref").top;
    const raisedBy = (id: string) => ref - rect(id).top;
    return {
      len: raisedBy("len"),
      pct: raisedBy("pct"),
      sup: raisedBy("sup"),
      sub: raisedBy("sub"),
      neg: raisedBy("neg"),
      raisedGrowth: rect("raised").height - rect("flat").height,
      loweredGrowth: rect("lowered").height - rect("flat").height,
    };
  });

  expect(got.len).toBe(6);
  expect(got.pct).toBe(6);
  expect(got.sup).toBeCloseTo(7.67, 0);
  expect(got.sub).toBe(-5);
  expect(got.neg).toBe(-4);
  expect(got.raisedGrowth).toBe(30);
  expect(got.loweredGrowth).toBe(30);
});

const rects = (ids: string[]) =>
  ids.map((id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error(`missing element #${id}`);
    const r = el.getBoundingClientRect();
    return { top: r.top, height: r.height };
  });

const topOf = (rect: { top: number } | undefined) => rect?.top ?? 0;

test("a line without a shifted box keeps its tight line-height", async ({ page }) => {
  await setContent(
    page,
    `<body style="margin:0;font:20px sans-serif"><div id="tight" style="line-height:8px;width:40px">text text</div>`,
  );
  const [tight] = await page.evaluate(rects, ["tight"]);
  expect(tight?.height).toBe(16);
});

test("a raised inline-block on a box-only line stays inside its line box", async ({ page }) => {
  await setContent(
    page,
    `<body style="margin:0;font:16px/20px sans-serif"><div id="line">${box("ref")}${box("up", "30px")}</div>`,
  );
  const [line, ref, up] = await page.evaluate(rects, ["line", "ref", "up"]);
  expect(topOf(up) - topOf(line)).toBe(0);
  expect(topOf(ref) - topOf(line)).toBe(30);
});

test("a lowered tall inline-block reserves only its shifted extents", async ({ page }) => {
  await setContent(
    page,
    `<body style="margin:0;font:16px/20px sans-serif"><div id="d">x<span id="b" style="display:inline-block;width:10px;height:40px;vertical-align:-10px"></span></div>`,
  );
  const [d, b] = await page.evaluate(rects, ["d", "b"]);
  expect(d?.height).toBe(40);
  expect(topOf(b) - topOf(d)).toBe(0);
});

test("changing vertical-align after layout moves the inline-block", async ({ page }) => {
  await setContent(
    page,
    `<body style="margin:0;font:20px/30px sans-serif"><div>${box("ref")}${box("b")}</div>`,
  );
  const got = await page.evaluate(() => {
    const top = (id: string) => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`missing element #${id}`);
      return el.getBoundingClientRect().top;
    };
    const before = top("ref") - top("b");
    const b = document.getElementById("b");
    if (!b) throw new Error("missing element #b");
    b.style.verticalAlign = "6px";
    return [before, top("ref") - top("b")];
  });
  expect(got).toEqual([0, 6]);
});
