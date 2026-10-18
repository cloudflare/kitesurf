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
