// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("iframe location assignment throws SyntaxError without replacing its facade", async ({
  page,
}) => {
  await setContent(page, "<iframe id=frame></iframe>");

  const result = await page.evaluate(() => {
    const contentWindow = document.querySelector<HTMLIFrameElement>("#frame")!.contentWindow!;
    const previousLocation = contentWindow.location;
    const FrameDOMException = (contentWindow as typeof window).DOMException;
    try {
      contentWindow.location = "http://example.com:80:";
      return { threw: false, sameLocation: contentWindow.location === previousLocation };
    } catch (error) {
      return {
        threw: true,
        name: (error as DOMException).name,
        code: (error as DOMException).code,
        isFrameDOMException: error instanceof FrameDOMException,
        constructorMatches: (error as DOMException).constructor === FrameDOMException,
        sameLocation: contentWindow.location === previousLocation,
      };
    }
  });

  expect(result).toEqual({
    threw: true,
    name: "SyntaxError",
    code: 12,
    isFrameDOMException: true,
    constructorMatches: true,
    sameLocation: true,
  });
});

test("iframe location href preserves string conversion errors", async ({ page }) => {
  await setContent(page, "<iframe id=frame></iframe>");

  const result = await page.evaluate(() => {
    const location = document.querySelector<HTMLIFrameElement>("#frame")!.contentWindow!.location;
    try {
      Reflect.set(location, "href", Symbol());
      return null;
    } catch (error) {
      return (error as Error).name;
    }
  });

  expect(result).toBe("TypeError");
});
