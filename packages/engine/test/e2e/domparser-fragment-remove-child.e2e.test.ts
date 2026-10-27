// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("DOMParser fragments do not remove nodes owned by another parent", async ({ page }) => {
  await setContent(page, "<p>Parsed fragment removal</p>");

  const result = await page.evaluate(() => {
    const parsed = new DOMParser().parseFromString("<div><span></span></div>", "text/html");
    const fragment = parsed.createDocumentFragment();
    const parent = parsed.querySelector("div")!;
    const child = parent.firstChild!;
    let errorName: string | null = null;
    try {
      fragment.removeChild(child);
    } catch (error) {
      errorName = (error as Error).name;
    }
    const fragmentChild = parsed.createElement("em");
    fragment.appendChild(fragmentChild);
    const removedFragmentChild = fragment.removeChild(fragmentChild);
    return {
      errorName,
      childStillAttached: child.parentNode === parent,
      removedFragmentChild: removedFragmentChild === fragmentChild,
      fragmentChildCount: fragment.childNodes.length,
    };
  });

  expect(result).toEqual({
    errorName: "NotFoundError",
    childStillAttached: true,
    removedFragmentChild: true,
    fragmentChildCount: 0,
  });
});

test("parsed documents expose their root and fragment element children", async ({ page }) => {
  await setContent(page, "<div></div>");
  const result = await page.evaluate(() => {
    const parsed = new DOMParser().parseFromString("<div></div>", "text/html");
    const root = parsed.documentElement;
    const fragment = parsed.createDocumentFragment();
    fragment.appendChild(parsed.createTextNode("text"));
    fragment.appendChild(parsed.createElement("span"));
    fragment.appendChild(parsed.createElement("b"));
    return {
      root: root?.localName,
      rootParent: root?.parentNode === parsed,
      childCount: fragment.childNodes.length,
      children: Array.from(fragment.children, (child) => child.localName),
    };
  });
  expect(result).toEqual({
    root: "html",
    rootParent: true,
    childCount: 3,
    children: ["span", "b"],
  });
});
