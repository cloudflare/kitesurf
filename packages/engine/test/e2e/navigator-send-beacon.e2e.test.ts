// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { setContent } from "./set-content";
import { expect, test } from "./harness";

test("navigator.sendBeacon is callable from page event handlers", async ({ page }) => {
  await setContent(page, "<button id=send>send</button>");

  const result = await page.evaluate(() => {
    let returned = false;
    let threw = false;
    document.querySelector("#send")!.addEventListener("click", () => {
      try {
        returned = navigator.sendBeacon("https://example.com/analytics", "event");
      } catch {
        threw = true;
      }
    });
    document.querySelector<HTMLButtonElement>("#send")!.click();
    return { returned, threw, type: typeof navigator.sendBeacon };
  });

  expect(result).toEqual({ returned: true, threw: false, type: "function" });
});

test("navigator.sendBeacon accepts relative URLs on HTTP documents", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "load",
  });

  const result = await page.evaluate(() => {
    try {
      return { returned: navigator.sendBeacon("/analytics", "event"), error: null };
    } catch (error) {
      return { returned: false, error: (error as Error).name };
    }
  });

  expect(result).toEqual({ returned: true, error: null });
});

test("navigator.sendBeacon throws for an invalid URL", async ({ page }) => {
  await setContent(page, "<p>Beacon URL validation</p>");

  const error = await page.evaluate(() => {
    try {
      navigator.sendBeacon("http://example.com:80:");
      return null;
    } catch (error) {
      return (error as { name?: string })?.name ?? String(error).split(":", 1)[0];
    }
  });

  expect(error).toBe("TypeError");
});
