// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { bbox, decodePng } from "./png";

const isRed = (r: number, g: number, b: number) => r > 150 && g < 80 && b < 80;
const isBlue = (r: number, g: number, b: number) => r < 80 && g < 80 && b > 150;

const TRANSLATED = `<body style="margin:0">
  <header style="height:57px"></header>
  <div id="portal"><div id="positioner" style="position:absolute;left:0;top:0">
    <div role="menu" style="width:144px">
      <div id="profile" role="menuitem" style="height:33px">Profile</div>
      <div id="appearance" role="menuitem" style="height:33px">Appearance</div>
    </div>
  </div></div>
  <script>
    window.log = [];
    for (const t of ["mouseenter", "click"]) {
      document.addEventListener(t, (e) => {
        if (e.target.id && e.target.getAttribute("role") === "menuitem") log.push(t + ":" + e.target.id);
      }, true);
    }
    requestAnimationFrame(() => {
      document.getElementById("positioner").style.transform = "translate(840px, 48px)";
      window.positioned = true;
    });
  </script>`;

test("pointer input reaches a popup moved by a transform", async ({ page }) => {
  await page.setViewport({ width: 1000, height: 600 });
  await setContent(page, TRANSLATED);
  await page.waitForFunction(() => Reflect.get(window, "positioned") === true);

  const hits = await page.evaluate(() => ({
    painted: document.elementFromPoint(912, 97)?.id,
    layoutOrigin: document.elementFromPoint(72, 49)?.tagName,
  }));
  expect(hits).toEqual({ painted: "appearance", layoutOrigin: "HEADER" });

  for (const [x, y] of [
    [912, 64],
    [912, 97],
  ] as const) {
    await page.mouse.move(x, y);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await page.mouse.click(912, 97);
  const log = await page.evaluate(() => Reflect.get(window, "log"));
  expect(log).toEqual(["mouseenter:profile", "mouseenter:appearance", "click:appearance"]);
});

test("a popup rendered after its fixed backdrop takes the hits", async ({ page }) => {
  await page.setViewport({ width: 1000, height: 600 });
  await setContent(
    page,
    `<html style="height:100%"><body style="margin:0;height:100%;overflow:hidden">
    <div style="height:100%"><header style="height:57px"></header></div>
    <div id="portal">
      <div id="backdrop" role="presentation" style="position:fixed;inset:0"></div>
      <div style="position:absolute;left:0;top:0;transform:translate(840px,48px)">
        <div role="menu" style="width:144px"><div id="appearance" style="height:33px">Appearance</div></div>
      </div>
    </div>
    <script>
      window.clicks = [];
      addEventListener("click", (e) => clicks.push(e.target.id));
    </script>`,
  );
  await page.mouse.click(912, 64);
  await page.mouse.click(300, 300);
  const result = await page.evaluate(() => ({
    item: document.elementFromPoint(912, 64)?.id,
    outside: document.elementFromPoint(300, 300)?.id,
    clicks: Reflect.get(window, "clicks"),
  }));
  expect(result).toEqual({
    item: "appearance",
    outside: "backdrop",
    clicks: ["appearance", "backdrop"],
  });
});

const DASH_MENU = `<html style="height:100%"><body style="margin:0;height:100%;overflow:hidden">
  <div style="isolation:isolate;height:100%">
    <input id="search" style="position:relative;z-index:1;display:block;margin-top:211px;width:940px;height:38px">
  </div>
  <div id="portal">
    <div id="backdrop" style="position:fixed;inset:0"></div>
    <div style="position:absolute;left:0;top:0;transform:translate(1060px,53px)">
      <div role="menu" style="width:204px;height:256px;pointer-events:none"><div style="height:109px"></div>
        <div id="appearance" style="height:33px;pointer-events:auto">Appearance</div></div>
    </div>
    <div>
      <div style="position:absolute;left:0;top:0;transform:translate(910px,162px)">
        <div role="menu" style="width:144px">
          <div id="light" style="height:33px">Light mode</div>
          <div id="dark" style="height:33px">Dark mode</div>
          <div id="system" style="height:33px">System</div>
        </div>
      </div>
    </div>
  </div>
  <script>
    window.clicks = [];
    addEventListener("click", (e) => clicks.push(e.target.id));
  </script>`;

test("every item of a submenu in a nested portal takes its click", async ({ page }) => {
  await page.setViewport({ width: 1280, height: 800 });
  await setContent(page, DASH_MENU);
  for (const [x, y] of [
    [982, 178],
    [982, 211],
    [982, 244],
    [1162, 178],
    [300, 228],
  ] as const) {
    await page.mouse.click(x, y);
  }
  const clicks = await page.evaluate(() => Reflect.get(window, "clicks"));
  expect(clicks).toEqual(["light", "dark", "system", "appearance", "backdrop"]);
});

const screenshot = async (page: Parameters<typeof setContent>[0], html: string) => {
  await page.setViewport({ width: 400, height: 200 });
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  return decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
};

test("body overflow:hidden does not clip a popup below the body's box", async ({ page }) => {
  const png = await screenshot(
    page,
    `<body style="margin:0;overflow:hidden"><header style="height:40px"></header>
    <div><div style="position:absolute;left:20px;top:80px;width:150px;height:80px;background:#e00"></div></div>`,
  );
  expect(bbox(png, 0, 200, isRed)).toEqual({ x: 20, y: 80, w: 150, h: 80 });
});

test("a fixed box paints under a later positioned sibling", async ({ page }) => {
  const png = await screenshot(
    page,
    `<body style="margin:0"><div>
      <div style="position:fixed;left:0;top:0;width:200px;height:100px;background:#e00"></div>
      <div style="position:absolute;left:100px;top:50px;width:200px;height:100px;background:#00e"></div>
    </div>`,
  );
  const pixel = (x: number, y: number): [number, number, number] => {
    const i = (y * png.width + x) * 4;
    return [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0];
  };
  expect(isBlue(...pixel(150, 75)), "the overlap shows the later abspos box").toBe(true);
  expect(isRed(...pixel(50, 75)), "the fixed box still paints outside the overlap").toBe(true);
});

test("a fixed box still escapes a clipping ancestor", async ({ page }) => {
  const nested = (wrapCss: string) => `<body style="margin:0">
    <div id="wrap" style="height:20px;${wrapCss}"><div>
      <div style="position:fixed;left:0;top:50px;width:300px;height:40px;background:#e00"></div>
    </div></div>`;
  const full = { x: 0, y: 50, w: 300, h: 40 };

  expect(bbox(await screenshot(page, nested("overflow:hidden")), 0, 200, isRed)).toEqual(full);
  expect(
    bbox(
      await screenshot(
        page,
        `<body style="margin:0"><div style="height:20px;overflow:hidden">
        <div style="position:fixed;left:0;top:50px;width:300px;height:40px;background:#e00"></div></div>`,
      ),
      0,
      200,
      isRed,
    ),
  ).toEqual(full);

  await screenshot(page, nested(""));
  await page.evaluate(() => {
    const wrap = document.getElementById("wrap");
    if (wrap) wrap.style.overflow = "hidden";
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  expect(bbox(png, 0, 200, isRed)).toEqual(full);
});
