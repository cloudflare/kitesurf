// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("element load events stop at the document", async ({ page }) => {
  await setContent(
    page,
    `
    <script>
      window.__loadCaptures = { document: 0, window: 0 };
      document.addEventListener("load", () => __loadCaptures.document++, true);
      window.addEventListener("load", () => __loadCaptures.window++, true);
    </script>
  `,
  );

  expect(
    await page.evaluate(() => {
      const captures = window.__loadCaptures!;
      const before = { ...captures };
      const image = document.createElement("img");
      document.documentElement.appendChild(image);
      image.dispatchEvent(new Event("load"));
      return {
        document: captures.document - before.document,
        window: captures.window - before.window,
      };
    }),
  ).toEqual({
    document: 1,
    window: 0,
  });
});

declare global {
  interface Window {
    __loadCaptures?: { document: number; window: number };
  }
}
