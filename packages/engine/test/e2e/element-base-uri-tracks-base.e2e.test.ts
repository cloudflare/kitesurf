// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("element URLs follow <base href> changes, insertion and removal", async ({ page }) => {
  await setContent(page, `<base href="https://one.example/dir/"><a id="a" href="x.html">x</a>`);

  const hrefs = await page.evaluate(() => {
    const a = document.getElementById("a") as HTMLAnchorElement;
    const base = document.querySelector("base") as HTMLBaseElement;
    const seen: (string | boolean)[] = [a.href, a.baseURI];
    base.setAttribute("href", "https://two.example/other/");
    seen.push(a.href);
    base.remove();
    seen.push(a.baseURI === document.URL);
    const added = document.createElement("base");
    added.href = "https://three.example/";
    document.head.appendChild(added);
    seen.push(a.href);
    return seen;
  });

  expect(hrefs).toEqual([
    "https://one.example/dir/x.html",
    "https://one.example/dir/",
    "https://two.example/other/x.html",
    true,
    "https://three.example/x.html",
  ]);
});
