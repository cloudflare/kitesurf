// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("dataset reads data-* off a DOMParser result", async ({ page }) => {
  await page.goto(
    "data:text/html," + encodeURIComponent("<!doctype html><html><body></body></html>"),
    {
      waitUntil: "domcontentloaded",
    },
  );

  const read = await page.evaluate(() => {
    const parsed = new DOMParser().parseFromString(
      '<div data-post-count="7" data-next-cursor="abc"></div>',
      "text/html",
    );
    const root = parsed.querySelector("[data-post-count]") as HTMLElement;
    return {
      postCount: root.dataset.postCount,
      nextCursor: root.dataset.nextCursor,
      missing: root.dataset.notThere,
      has: "postCount" in root.dataset,
    };
  });

  expect(read).toEqual({
    postCount: "7",
    nextCursor: "abc",
    missing: undefined,
    has: true,
  });
});
