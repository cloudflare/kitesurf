// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { expect, test } from "../harness";
import { setContent } from "../set-content";

const HTML = `<style>body{margin:0;height:3000px}</style>
  <div id="host" style="width:200px;height:200px;overflow:scroll"></div>`;

async function addShadowContent(page: Page) {
  await page.evaluate(() => {
    const host = document.getElementById("host")!;
    host.attachShadow({ mode: "open" }).innerHTML =
      '<div style="height:800px"></div><div id="target" style="height:50px">target</div>';
  });
}

test("wheel over shadow content scrolls its host", async ({ page }) => {
  await setContent(page, HTML);
  await addShadowContent(page);

  const rect = await page.evaluate(() => {
    const r = document.getElementById("host").getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  await page.mouse.move(rect.left + 100, rect.top + 100);
  await page.mouse.wheel({ deltaY: 120 });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const scroll = await page.evaluate(() => ({
    host: document.getElementById("host").scrollTop,
    viewport: window.scrollY,
  }));
  expect(scroll.host).toBe(120);
  expect(scroll.viewport).toBe(0);
});

test("scrollIntoView traverses shadow-root parents safely", async ({ page }) => {
  await setContent(page, HTML);
  await addShadowContent(page);

  const scroll = await page.evaluate(async () => {
    const host = document.getElementById("host")!;
    host.shadowRoot!.querySelector("#target")!.scrollIntoView();
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { host: host.scrollTop, viewport: window.scrollY };
  });
  expect(scroll.host).toBeGreaterThan(0);
  expect(scroll.viewport).toBe(150);
});
