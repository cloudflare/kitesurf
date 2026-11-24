// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// `:hover` follows the pointer: moving onto an element applies its hover rules
// and moving away reverts them, including for an ancestor of the hit node.
// https://drafts.csswg.org/selectors-4/#the-hover-pseudo
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<!doctype html><html><head><style>
  body { margin: 0 }
  #box { position: absolute; left: 0; top: 0; width: 200px; height: 100px; background: rgb(0, 0, 255) }
  #box:hover { background: rgb(255, 0, 0) }
  #box:hover #label { color: rgb(0, 128, 0) }
  #label { color: rgb(0, 0, 0) }
</style></head><body>
<div id="box"><span id="label">hover me</span></div>
<script>
  globalThis.__hover = function () {
    return JSON.stringify({
      box: getComputedStyle(document.getElementById("box")).backgroundColor,
      label: getComputedStyle(document.getElementById("label")).color,
    });
  };
</script></body></html>`;

test("a :hover rule applies while the pointer is over the element", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__hover()")).toEqual({
    box: "rgb(0, 0, 255)",
    label: "rgb(0, 0, 0)",
  });

  await page.mouse.move(50, 50);
  await expect
    .poll(() => readJsonReport(cdpSession, "globalThis.__hover()"), { timeout: 5_000 })
    .toEqual({ box: "rgb(255, 0, 0)", label: "rgb(0, 128, 0)" });

  await page.mouse.move(400, 400);
  await expect
    .poll(() => readJsonReport(cdpSession, "globalThis.__hover()"), { timeout: 5_000 })
    .toEqual({ box: "rgb(0, 0, 255)", label: "rgb(0, 0, 0)" });
}, 60_000);

test(":hover hit-tests in scrolled page coordinates", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><html><head><style>
      body { margin: 0; }
      .row { height: 100px; background: rgb(0, 0, 255); }
      .row:hover { background: rgb(255, 0, 0); }
    </style></head><body>
      ${Array.from({ length: 20 }, (_, i) => `<div id="d${i}" class="row">row ${i}</div>`).join("")}
    </body></html>`,
    { waitUntil: "domcontentloaded" },
  );
  await page.evaluate(() => window.scrollTo(0, 1000));
  await page.mouse.move(50, 50);
  const result = await page.evaluate(() => ({
    atPoint: document.elementFromPoint(50, 50)?.id ?? null,
    d0Bg: getComputedStyle(document.getElementById("d0")!).backgroundColor,
    d10Bg: getComputedStyle(document.getElementById("d10")!).backgroundColor,
  }));
  expect(result.atPoint).toBe("d10");
  expect(result.d10Bg).toBe("rgb(255, 0, 0)");
  expect(result.d0Bg).toBe("rgb(0, 0, 255)");
}, 60_000);
