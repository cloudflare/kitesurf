// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const perCharSpans = (text: string) => [...text].map((c) => `<span>${c}</span>`).join("");

test("spaces at inline span edges survive and give break opportunities", async ({ page }) => {
  const sentence = "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll";
  await setContent(
    page,
    `<style>body { margin: 0; font: 16px/20px sans-serif } p { margin: 0; width: max-content }</style>
    <p id=plain>a b</p>
    <p id=leading>a<span> b</span></p>
    <p id=trailing><a>a </a>b</p>
    <p id=only-space><span>a</span><span> </span><span>b</span></p>
    <p id=glued>ab</p>
    <p id=collapsed><span>a </span><span> </span><span> b</span></p>
    <p id=edges><span> </span> a b <span> </span></p>
    <div style="width: 200px"><p id=wrapped style="width: auto">${perCharSpans(sentence)}</p></div>
    <div style="display: grid; width: 200px; place-content: center"><p id=grid style="width: auto">${perCharSpans(sentence)}</p></div>`,
  );

  const boxes = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll("p")].map((p) => {
        const r = p.getBoundingClientRect();
        return [p.id, { w: Math.round(r.width), h: Math.round(r.height) }];
      }),
    ),
  );
  const box = (id: string) => {
    const b = boxes[id];
    if (!b) throw new Error(`no <p id=${id}>`);
    return b;
  };

  for (const id of ["leading", "trailing", "only-space", "collapsed"]) {
    expect(box(id).w, id).toBe(box("plain").w);
  }
  expect(box("plain").w).toBeGreaterThan(box("glued").w);
  expect(box("edges").w).toBe(box("plain").w);

  for (const id of ["wrapped", "grid"]) {
    expect(box(id).w, id).toBeLessThanOrEqual(200);
    expect(box(id).h, id).toBeGreaterThanOrEqual(60);
  }
});
