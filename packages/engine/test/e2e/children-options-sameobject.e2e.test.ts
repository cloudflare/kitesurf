// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("children and options are one live collection per element", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>t</title>
    <ul id=u><li>a</li>text<li>b</li></ul>
    <select id=s><option>A</option><optgroup><option>B</option></optgroup></select>`,
  );
  const state = await page.evaluate(() => {
    const u = document.getElementById("u");
    const s = document.getElementById("s");
    if (!u || !(s instanceof HTMLSelectElement)) throw new Error("fixture missing");
    const kids = u.children;
    const opts = s.options;
    const before = { kids: kids.length, opts: opts.length, length: s.length };
    const li = document.createElement("li");
    li.textContent = "c";
    u.appendChild(li);
    const firstChild = u.firstElementChild;
    if (!firstChild) throw new Error("no element child");
    firstChild.remove();
    const group = s.querySelector("optgroup");
    if (!group) throw new Error("no optgroup");
    group.appendChild(document.createElement("option"));
    return {
      same: u.children === kids && s.options === opts,
      before,
      after: {
        kids: Array.from(kids, (e) => e.textContent),
        first: u.firstElementChild?.textContent,
        count: u.childElementCount,
        opts: opts.length,
        length: s.length,
      },
    };
  });
  expect(state).toEqual({
    same: true,
    before: { kids: 2, opts: 2, length: 2 },
    after: { kids: ["b", "c"], first: "b", count: 2, opts: 3, length: 3 },
  });
}, 60_000);
