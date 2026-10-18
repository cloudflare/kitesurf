// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("a relative location write on an about:blank iframe navigates the frame", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const heading = await page.evaluate(
    () =>
      new Promise<string | null>((resolve, reject) => {
        const frame = document.createElement("iframe");
        document.body.appendChild(frame);
        const frameWindow = frame.contentWindow;
        if (!frameWindow) {
          reject(new Error("about:blank iframe has no window"));
          return;
        }
        frame.onload = () => {
          resolve(frame.contentDocument?.getElementById("hdr")?.textContent ?? null);
        };
        frameWindow.location.replace("/__fixtures/iframe-child.html");
      }),
  );

  expect(heading).toBe("Child heading");
});
