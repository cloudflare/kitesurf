// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("dom-mutate2-demo", async ({ page }) => {
  const FIXTURE_URL =
    process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/events.html";

  await page.goto(FIXTURE_URL, { timeout: 15000 });

  const test1 = await page.evaluate(() => {
    const ul = document.createElement("ul");
    ul.id = "list-1";
    document.body.appendChild(ul);
    for (let i = 0; i < 3; i++) {
      const li = document.createElement("li");
      li.textContent = "item " + i;
      ul.appendChild(li);
    }
    return document.querySelector("#list-1").outerHTML;
  });
  expect(
    test1.includes("item 0") && test1.includes("item 2") && test1.includes('id="list-1"'),
    "test1 createElement + appendChild round-trip: " + test1,
  ).toBeTruthy();

  const test2 = await page.evaluate(() => {
    const ul = document.querySelector("#list-1");
    const newLi = document.createElement("li");
    newLi.textContent = "item -1";
    newLi.className = "first";
    ul.insertBefore(newLi, ul.firstChild);
    return ul.outerHTML;
  });
  expect(
    test2.indexOf("item -1") >= 0 && test2.indexOf("item -1") < test2.indexOf("item 0"),
    "test2 insertBefore: " + test2,
  ).toBeTruthy();

  const test3 = await page.evaluate(() => {
    const ul = document.querySelector("#list-1");
    const items = Array.from(ul.children);
    const target = items.find((el) => el.textContent === "item 1");
    if (!target) return { ok: false, reason: "couldn't find item 1" };
    ul.removeChild(target);
    return {
      ok: true,
      remaining: Array.from(ul.children).map((c) => c.textContent),
    };
  });
  expect(
    test3.ok && test3.remaining.length === 3 && !test3.remaining.includes("item 1"),
    "test3 removeChild: " + JSON.stringify(test3),
  ).toBeTruthy();

  const test4 = await page.evaluate(() => {
    const ul = document.querySelector("#list-1");
    const old = Array.from(ul.children).find((c) => c.textContent === "item 2");
    if (!old) return { ok: false };
    const fresh = document.createElement("li");
    fresh.textContent = "item 99";
    fresh.setAttribute("data-replaced", "yes");
    ul.replaceChild(fresh, old);
    return {
      ok: true,
      remaining: Array.from(ul.children).map((c) => c.textContent),
      hasReplacedAttr: !!ul.querySelector('[data-replaced="yes"]'),
    };
  });
  expect(
    test4.ok &&
      test4.remaining.includes("item 99") &&
      !test4.remaining.includes("item 2") &&
      test4.hasReplacedAttr,
    "test4 replaceChild: " + JSON.stringify(test4),
  ).toBeTruthy();

  const test5 = await page.evaluate(() => {
    const ul = document.querySelector("#list-1");
    const first = ul.firstChild;
    if (!first) return { ok: false };
    const before = ul.children.length;
    first.remove();
    return { ok: true, before, after: ul.children.length };
  });
  expect(
    test5.ok && test5.after === test5.before - 1,
    "test5 element.remove(): " + JSON.stringify(test5),
  ).toBeTruthy();
});
