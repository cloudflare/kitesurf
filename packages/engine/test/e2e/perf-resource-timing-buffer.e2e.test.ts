// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("resource-timing buffer sizing preserves marks and requires an argument", async ({ page }) => {
  await setContent(page, "<p>timing</p>");
  const result = await page.evaluate(() => {
    const setSize: unknown = Reflect.get(performance, "setResourceTimingBufferSize");
    if (typeof setSize !== "function") throw new Error("missing buffer-size method");
    performance.mark("before-sizing");
    let missingArgument = false;
    try {
      setSize.call(performance);
    } catch (error) {
      missingArgument = String(error).includes("TypeError");
    }
    return {
      missingArgument,
      result: setSize.call(performance, 10000),
      marks: performance.getEntriesByName("before-sizing", "mark").length,
    };
  });
  expect(result).toEqual({ missingArgument: true, result: undefined, marks: 1 });
});
