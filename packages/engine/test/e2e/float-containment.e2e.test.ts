// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const HTML = `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>float containment</title>
<style>
  body { margin: 0 }
  section { width: 600px }
  .f { float: left; width: 200px; height: 150px; background: #fcc }
  .tall { float: left; width: 100px; height: 250px; background: #ccf }
  .cl { clear: both; height: 20px; background: #cfc }
  #tbl .cl { display: table }
  #grid .cl { display: grid }
  #flex .cl { display: flex }
  #ovh .cl { display: block; overflow: hidden }
  #fr { display: flow-root }
</style>
</head>
<body>
  <section id="tbl"><div class="f"></div><div class="cl"></div></section>
  <section id="grid"><div class="f"></div><div class="cl"></div></section>
  <section id="flex"><div class="f"></div><div class="cl"></div></section>
  <section id="ovh"><div class="f"></div><div class="cl"></div></section>
  <section id="two"><div class="f"></div><div class="tall"></div><div class="cl"></div></section>
  <section id="twoflip"><div class="tall"></div><div class="f"></div><div class="cl"></div></section>
  <section id="right"><div class="f" style="float:right"></div><div class="cl" style="clear:right"></div></section>
  <section id="crossclear"><div class="f" style="float:right"></div><div class="cl" style="clear:left"></div></section>
  <section id="innerbfc"><div style="display:flow-root"><div class="f"></div></div><div class="cl"></div></section>
  <section id="fr"><div class="f"></div></section>
  <section id="plain"><div class="f"></div></section>
</body>
</html>`;

test("a cleared child and a flow-root box both contain their floats", async ({ page }) => {
  await page.setViewport({ width: 700, height: 600 });
  await setContent(page, HTML, { waitUntil: "domcontentloaded" });

  const heights = await page.evaluate(() =>
    Object.fromEntries(
      [
        "tbl",
        "grid",
        "flex",
        "ovh",
        "two",
        "twoflip",
        "right",
        "crossclear",
        "innerbfc",
        "fr",
        "plain",
      ].map((id) => [id, Math.round(document.getElementById(id)!.getBoundingClientRect().height)]),
    ),
  );

  expect(heights).toEqual({
    tbl: 170,
    grid: 170,
    flex: 170,
    ovh: 170,
    two: 270,
    twoflip: 270,
    right: 170,
    crossclear: 20,
    innerbfc: 170,
    fr: 150,
    plain: 0,
  });
}, 120_000);
