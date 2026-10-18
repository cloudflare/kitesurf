// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("parsed anchor values do not panic during layout", async ({ page }) => {
  await setContent(
    page,
    `<div id="target" style="
        position: absolute;
        line-height: 20px;
        width: anchor-size(--anchor width, 40px);
        min-height: anchor-size(--anchor height, 20px);
        max-width: anchor-size(--anchor width, 30px);
        margin-left: anchor-size(--anchor inline, 5px);
        left: anchor(--anchor right, 10px);
        top: anchor(--anchor bottom, 10px);
      ">target</div>
      <div id="inset" style="position: absolute; left: 0; top: anchor-size(--anchor height, 30px)">inset</div>
      <div id="calc" style="position: absolute; width: calc(anchor-size(--anchor width, 30px) + 1px)">calc</div>`,
  );

  const read = await page.evaluate(() => {
    const target = document.getElementById("target") as HTMLElement;
    const inset = document.getElementById("inset") as HTMLElement;
    const calc = document.getElementById("calc") as HTMLElement;
    const targetRect = target.getBoundingClientRect();
    const insetRect = inset.getBoundingClientRect();
    return {
      targetStyleWidth: target.style.width,
      targetRect: {
        x: targetRect.x,
        y: targetRect.y,
        width: targetRect.width,
        height: targetRect.height,
      },
      insetRect: { x: insetRect.x, y: insetRect.y },
      calcWidth: calc.getBoundingClientRect().width,
    };
  });

  expect(read.targetStyleWidth).toBe("anchor-size(--anchor width, 40px)");
  expect(read.targetRect).toEqual({ x: 15, y: 10, width: 30, height: 20 });
  expect(read.insetRect).toEqual({ x: 0, y: 30 });

  expect(read.calcWidth).toBeGreaterThan(0);
  await page.screenshot();
}, 120_000);
