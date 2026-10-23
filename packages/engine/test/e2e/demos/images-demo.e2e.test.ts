// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

function expectImageRect(rect, id: string): void {
  expect(
    rect && rect.w === 64 && rect.h === 64,
    `${id}-rect: ${JSON.stringify(rect)}`,
  ).toBeTruthy();
}

function expectImageHit(hit, id: string): void {
  expect(hit && hit.id === id, `${id}-hit: ${JSON.stringify(hit)}`).toBeTruthy();
}

test("images-demo", async ({ page }) => {
  const RED_8x8_B64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";

  await page.goto("https://example.com/__fixtures/inline-script.html", { timeout: 25000 });
  await new Promise((r) => setTimeout(r, 500));

  await page.evaluate((red8) => {
    document.body.innerHTML =
      "" +
      "<div id='wrapper' style=\"padding:20px;background:white\">" +
      "<img id='data-img' width='64' height='64' " +
      "src='data:image/png;base64," +
      red8 +
      "'>" +
      "<div id='bg' style=\"width:64px;height:64px;" +
      "background-image:url(data:image/png;base64," +
      red8 +
      ");" +
      'background-size:64px 64px;background-repeat:no-repeat"></div>' +
      "<img id='dyn-img' width='64' height='64'>" +
      "</div>";
    setTimeout(() => {
      const dyn = document.getElementById("dyn-img") as HTMLImageElement;
      if (dyn) dyn.src = "data:image/png;base64," + red8;
    }, 50);
  }, RED_8x8_B64);

  const probe = await page.evaluate(() => {
    function r(id) {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    }
    return {
      dataImg: r("data-img"),
      bg: r("bg"),
      dynImg: r("dyn-img"),
    };
  });
  console.log("[img] geometry:", probe);
  expectImageRect(probe.dataImg, "data-img");
  expectImageRect(probe.bg, "bg");
  expectImageRect(probe.dynImg, "dyn-img");

  const buf = await page.screenshot({ encoding: "binary" });
  console.log(`[img] screenshot captured (${buf.length} bytes)`);

  const sample = await page.evaluate(
    ({ probe }) => {
      function elAt(rect) {
        const cx = rect.x + Math.floor(rect.w / 2);
        const cy = rect.y + Math.floor(rect.h / 2);
        const el = document.elementFromPoint(cx, cy);
        return el ? { tag: el.tagName, id: el.id } : null;
      }
      return {
        dataImg: elAt(probe.dataImg),
        bg: elAt(probe.bg),
        dynImg: elAt(probe.dynImg),
      };
    },
    { probe },
  );
  console.log("[img] hit-tests:", sample);
  expectImageHit(sample.dataImg, "data-img");
  expectImageHit(sample.bg, "bg");
  expectImageHit(sample.dynImg, "dyn-img");
});
