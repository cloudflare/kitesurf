// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("a setTimeout(0)-inserted image still delays the load event", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/late-timer-insert.html", {
    waitUntil: "load",
    timeout: 30000,
  });

  const atLoad = (await page.evaluate(`
    ({
      timerRan: window.__timerRan === true,
      img: !!document.getElementById("late"),
      complete: document.getElementById("late")?.complete === true,
    })
  `)) as { timerRan: boolean; img: boolean; complete: boolean };
  expect(atLoad.timerRan).toBe(true);
  expect(atLoad.img).toBe(true);
  expect(atLoad.complete).toBe(true);
});
