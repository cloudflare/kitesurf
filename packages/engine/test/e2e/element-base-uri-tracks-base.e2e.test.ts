// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("element URLs follow <base href> changes, insertion and removal", async ({ page }) => {
  await setContent(page, `<base href="https://one.example/dir/"><a id="a" href="x.html">x</a>`);

  const observed = await page.evaluate(() => {
    const anchor = document.getElementById("a") as HTMLAnchorElement;
    const base = document.querySelector("base") as HTMLBaseElement;
    const initial = [anchor.href, anchor.baseURI];

    base.setAttribute("href", "https://two.example/other/");
    const afterHrefChange = anchor.href;

    base.remove();
    const baseUriIsDocumentUrl = anchor.baseURI === document.URL;

    const added = document.createElement("base");
    added.href = "https://three.example/";
    document.head.appendChild(added);
    const afterInsertion = anchor.href;

    return { initial, afterHrefChange, baseUriIsDocumentUrl, afterInsertion };
  });

  expect(observed).toEqual({
    initial: ["https://one.example/dir/x.html", "https://one.example/dir/"],
    afterHrefChange: "https://two.example/other/x.html",
    baseUriIsDocumentUrl: true,
    afterInsertion: "https://three.example/x.html",
  });
});
