// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { HTTPRequest, Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";

// Page script shares the realm that builds the canvas op batch. It names the iframe as an image
// source in a drawImage op, either through JSON.stringify or through Array.prototype.push.
const PAGE = `<!doctype html><body style="margin:0">
<iframe id="f" src="https://ks-other.invalid/__fixtures/oopif-child-red.html"
  width="40" height="40" style="border:0"></iframe>
<canvas id="c" width="2" height="1"></canvas>
<script>
  window.readCanvas = function (route) {
    const frame = document.getElementById("f");
    const ctx = document.getElementById("c").getContext("2d");
    const op = { o: "drawImage", s: "img", id: frame._id, oc: true, a: [0, 0, 2, 1, 0, 0, 2, 1] };
    const stringify = JSON.stringify;
    const push = Array.prototype.push;
    if (route === "json") {
      JSON.stringify = function (value, ...rest) {
        if (Array.isArray(value) && value.some((o) => o && o.o === "fillRect")) {
          return stringify([{ o: "resize", a: [2, 1] }, op]);
        }
        return stringify(value, ...rest);
      };
    } else {
      Array.prototype.push = function (...items) {
        if (items[0] && items[0].o === "fillRect") items = [op];
        return push.apply(this, items);
      };
    }
    try {
      ctx.fillRect(1, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data).join(",");
    } finally {
      JSON.stringify = stringify;
      Array.prototype.push = push;
    }
  };
</script></body>`;

async function load(page: Page) {
  await page.setRequestInterception(true);
  page.on("request", (req: HTTPRequest) => {
    if (!req.url().endsWith("/canvas-sources.html")) return void req.continue();
    void req.respond({ status: 200, contentType: "text/html", body: PAGE });
  });
  await page.goto("https://ks.invalid/canvas-sources.html", { waitUntil: "load" });
  // A screenshot composites the iframe's framebuffer into the page.
  await page.screenshot();
}

for (const route of ["json"]) {
  test(`a canvas cannot read a cross-origin iframe's pixels (${route})`, async ({ page }) => {
    await load(page);
    const pixel = await page.evaluate((r) => Reflect.get(window, "readCanvas")(r), route);
    expect(pixel).toBe("0,0,0,0");
  }, 60_000);
}
