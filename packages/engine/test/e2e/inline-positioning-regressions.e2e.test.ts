// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { loadLayoutPage } from "./layout-test-helpers";
import { decodePng } from "./png";

const PADDED_INLINE_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #nav {
    width: 800px;
    height: 50px;
    margin: 0;
    padding: 0 200px;
    font-size: 0;
  }
  #nav > li { display: inline-block; width: 100px; height: 50px }
  #nav a { display: inline-block; width: 100%; height: 50px; font-size: 16px }
</style>
<ul id="nav"><li><a href="#">First</a></li><li id="target"><a id="target-link" href="#">Target</a></li></ul>`;

const RELATIVE_INLINE_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #host { width: 600px; height: 100px; background: #eef2f5 }
  #button {
    display: inline-block;
    vertical-align: top;
    position: relative;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 100px;
    height: 20px;
    background: #f00;
  }
</style>
<div id="host"><a id="button" href="#">Button</a></div>`;

const RELATIVE_FIXED_HTML = `<!doctype html>
<style>
  html, body { margin: 0; width: 800px; height: 600px }
  #overlay { position: fixed; inset: 0; background: #eef2f5 }
  #form {
    position: relative;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 200px;
    height: 40px;
    background: #f00;
  }
</style>
<div id="overlay"><form id="form"></form></div>`;

const RELATIVE_FIXED_ASYMMETRIC_HTML = `<!doctype html>
<style>
  html, body { margin: 0; width: 800px; height: 600px }
  #overlay {
    position: fixed;
    top: 20px;
    right: 0;
    bottom: 60px;
    left: 0;
    background: #eef2f5;
  }
  #form {
    position: relative;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 200px;
    height: 40px;
    background: #f00;
  }
</style>
<div id="overlay"><form id="form"></form></div>`;

const RELATIVE_FIXED_OVERFLOW_HTML = `<!doctype html>
<style>
  html, body { margin: 0; width: 800px; height: 600px }
  #overlay { position: fixed; inset: 0; background: #eef2f5 }
  #long { height: 4000px; visibility: hidden }
  #form {
    position: relative;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 200px;
    height: 40px;
    background: #f00;
  }
</style>
<div id="overlay"><form id="form"></form><div id="long"></div></div>`;

const RELATIVE_HEADER_LABELS_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #column { float: left; width: 800px }
  #header { height: 100px; position: relative }
  #logo {
    display: inline-block;
    position: relative;
    top: 50%;
    transform: translateY(-50%);
    width: 220px;
    height: 33px;
    line-height: 0;
    font-size: 0;
    margin: 0;
  }
  #labels {
    float: right;
    position: relative;
    left: 25px;
    top: 50%;
    transform: translateY(-50%);
    width: 200px;
    line-height: 20px;
    background: #f00;
  }
  #labels > span { display: inline-block; padding: 5px 0; margin-left: 40px }
</style>
<div id="column"><div id="header"><h1 id="logo"></h1><div id="labels"><span>English</span><span>Aplicações</span></div></div></div>`;

const RELATIVE_NON_LENGTH_HEIGHT_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  .outer { height: 200px }
  .parent { width: 100px }
  #percent { height: 100% }
  #flex { display: flex }
  .child {
    display: inline-block;
    position: relative;
    top: 50%;
    width: 10px;
    height: 10px;
  }
</style>
<div class="outer"><div id="percent" class="parent"><span class="child"></span></div></div>
<div id="flex" class="outer"><div id="stretched" class="parent"><span class="child"></span></div></div>`;

test("hit-tests children inside a padded inline root", async ({ page }) => {
  await loadLayoutPage(page, PADDED_INLINE_HTML);
  const point = await page.evaluate(() => {
    const rect = document.getElementById("target-link")!.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, point)).toBe(
    "target-link",
  );
}, 120_000);

test("applies relative offsets to inline blocks", async ({ page }) => {
  await loadLayoutPage(page, RELATIVE_INLINE_HTML);
  const png = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  const pixel = (50 * png.width + 260) * 4;
  expect(Array.from(png.data.slice(pixel, pixel + 4))).toEqual([255, 0, 0, 255]);
}, 120_000);

test("resolves relative percentages inside fixed viewport boxes", async ({ page }) => {
  await loadLayoutPage(page, RELATIVE_FIXED_HTML);
  const png = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  const pixel = (300 * png.width + 400) * 4;
  expect(Array.from(png.data.slice(pixel, pixel + 4))).toEqual([255, 0, 0, 255]);
}, 120_000);

test("resolves relative percentages against an asymmetric fixed parent", async ({ page }) => {
  await loadLayoutPage(page, RELATIVE_FIXED_ASYMMETRIC_HTML);
  const png = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  const pixel = (280 * png.width + 400) * 4;
  expect(Array.from(png.data.slice(pixel, pixel + 4))).toEqual([255, 0, 0, 255]);
}, 120_000);

test("keeps fixed viewport percentages stable when content overflows", async ({ page }) => {
  await loadLayoutPage(page, RELATIVE_FIXED_OVERFLOW_HTML);
  const png = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  const pixel = (300 * png.width + 400) * 4;
  expect(Array.from(png.data.slice(pixel, pixel + 4))).toEqual([255, 0, 0, 255]);
}, 120_000);

test("centers a floated relative header label group after an inline logo", async ({ page }) => {
  await loadLayoutPage(page, RELATIVE_HEADER_LABELS_HTML);
  const x = await page.evaluate(() => document.getElementById("labels")!.getBoundingClientRect().x);
  const png = await decodePng(new Uint8Array(await page.screenshot({ type: "png" })));
  const pixel = (35 * png.width + 725) * 4;
  expect(Math.round(x)).toBe(625);
  expect(Array.from(png.data.slice(pixel, pixel + 4))).toEqual([255, 0, 0, 255]);
}, 120_000);

test("resolves relative percentages against used non-length heights", async ({ page }) => {
  await loadLayoutPage(page, RELATIVE_NON_LENGTH_HEIGHT_HTML);
  const offsets = await page.evaluate(() =>
    Object.fromEntries(
      ["percent", "stretched"].map((id) => {
        const parent = document.getElementById(id)!;
        const child = parent.firstElementChild!;
        return [id, child.getBoundingClientRect().top - parent.getBoundingClientRect().top];
      }),
    ),
  );
  expect(offsets).toEqual({ percent: 107, stretched: 107 });
}, 120_000);
