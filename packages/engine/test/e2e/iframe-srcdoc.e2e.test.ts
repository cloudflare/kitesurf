// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("an iframe that gets srcdoc after insertion loads that content", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const text = await page.evaluate(
    () =>
      new Promise<string | null>((resolve) => {
        const frame = document.createElement("iframe");
        document.body.appendChild(frame);
        frame.srcdoc = '<p id="doc">from srcdoc</p>';
        frame.onload = () => {
          resolve(frame.contentDocument?.getElementById("doc")?.textContent ?? null);
        };
      }),
  );

  expect(text).toBe("from srcdoc");
});

test("an iframe with srcdoc set before insertion loads that content", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const text = await page.evaluate(
    () =>
      new Promise<string | null>((resolve) => {
        const frame = document.createElement("iframe");
        frame.srcdoc = '<p id="doc">before insertion</p>';
        frame.onload = () => {
          resolve(frame.contentDocument?.getElementById("doc")?.textContent ?? null);
        };
        document.body.appendChild(frame);
      }),
  );

  expect(text).toBe("before insertion");
});

test("srcdoc takes precedence over src", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/iframe-host.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const text = await page.evaluate(
    () =>
      new Promise<string | null>((resolve) => {
        const frame = document.createElement("iframe");
        frame.src = "/__fixtures/iframe-child.html";
        frame.srcdoc = '<p id="doc">srcdoc wins</p>';
        frame.onload = () => {
          resolve(frame.contentDocument?.getElementById("doc")?.textContent ?? null);
        };
        document.body.appendChild(frame);
      }),
  );

  expect(text).toBe("srcdoc wins");
});
