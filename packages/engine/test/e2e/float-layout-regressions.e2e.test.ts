// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { loadLayoutPage } from "./layout-test-helpers";

const ABSOLUTE_FLOAT_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #host { position: relative; width: 800px; height: 50px }
  #menu {
    position: absolute;
    top: 50px;
    left: 0;
    width: 800px;
    height: auto;
    min-height: 0;
    box-sizing: border-box;
    padding: 40px 100px;
    margin: 0;
    list-style: none;
  }
  #menu > li { float: left; width: 25%; min-height: 220px }
  #menu > li.tall { min-height: 280px }
</style>
<div id="host"><ul id="menu"><li>One</li><li class="tall">Two</li><li>Three</li><li>Four</li></ul></div>`;

test("contains floated children in an auto-height absolute box", async ({ page }) => {
  await loadLayoutPage(page, ABSOLUTE_FLOAT_HTML);
  expect(Math.round(await page.$eval("#menu", (menu) => menu.getBoundingClientRect().height))).toBe(
    360,
  );
}, 120_000);
