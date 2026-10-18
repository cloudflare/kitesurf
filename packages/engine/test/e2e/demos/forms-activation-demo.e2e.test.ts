// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

declare global {
  interface Window {
    __submits?: number;
    __lastSubmitter?: string;
  }
}

test("forms-activation-demo", async ({ page }) => {
  await page.goto(
    "data:text/html," +
      encodeURIComponent(`<!doctype html><html><body>
        <form id="f">
          <input id="text" name="q" type="text">
          <input id="email" name="e" type="email">
          <button id="b1" type="submit" name="action" value="save">Save</button>
          <button id="b2" type="button">Plain</button>
          <button id="b3" type="reset">Reset</button>
        </form>
        <form id="f2">
          <input id="t2" name="x" value="orig">
        </form>
      </body></html>`),
  );

  await page.evaluate(() => {
    window.__submits = 0;
    window.__lastSubmitter = "";
    document.getElementById("f").addEventListener("submit", (e) => {
      window.__submits++;
      window.__lastSubmitter = e.submitter ? e.submitter.id : "null";
      e.preventDefault();
    });
  });

  await page.evaluate(() => document.getElementById("b1").click());
  let info: { submits: number; submitter: string } | number = await page.evaluate(() => ({
    submits: window.__submits,
    submitter: window.__lastSubmitter,
  }));
  expect(info.submits, "submit button .click() fires submit").toBe(1);
  expect(info.submitter, "submitter = b1").toBe("b1");

  await page.evaluate(() => {
    (document.getElementById("text") as HTMLInputElement).value = "modified";
  });
  let modified = await page.evaluate(
    () => (document.getElementById("text") as HTMLInputElement).value,
  );
  expect(modified, "input value modified").toBe("modified");
  await page.evaluate(() => document.getElementById("b3").click());
  const afterReset = await page.evaluate(
    () => (document.getElementById("text") as HTMLInputElement).value,
  );
  expect(afterReset, "reset button .click() resets").toBe("");

  await page.evaluate(() => {
    window.__submits = 0;
  });
  await page.evaluate(() => document.getElementById("b2").click());
  info = await page.evaluate(() => window.__submits);
  expect(info, "type=button doesn't submit").toBe(0);

  await page.evaluate(() => {
    window.__submits = 0;
    window.__lastSubmitter = "MISSING";
    document.getElementById("f").addEventListener("submit", (e) => {
      window.__submits++;
      window.__lastSubmitter = e.submitter ? e.submitter.id : "null";
      e.preventDefault();
    });
  });

  await page.focus("#text");
  await page.type("#text", "hello");
  await page.keyboard.press("Enter");
  await page
    .waitForFunction(() => (globalThis as any).__submits >= 1, {
      timeout: 10_000,
    })
    .catch(() => {});

  info = await page.evaluate(() => ({
    submits: window.__submits,
    submitter: window.__lastSubmitter,
  }));
  expect(info.submits >= 1, "Enter in input triggers implicit submit").toBeTruthy();
  expect(info.submitter, "implicit submitter = b1").toBe("b1");

  await page.evaluate(() => {
    window.__submits = 0;
    const b = document.getElementById("b1");
    b.addEventListener("click", (e) => e.preventDefault(), { once: true });
  });
  await page.evaluate(() => document.getElementById("b1").click());
  info = await page.evaluate(() => window.__submits);
  expect(info, "preventDefault on click blocks submit").toBe(0);
});
