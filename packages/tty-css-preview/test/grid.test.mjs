// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const extensionUrl = new URL("../extension/", import.meta.url);

test("offers an optional visual cell grid", async () => {
  const [popup, background, content] = await Promise.all([
    readFile(new URL("popup.html", extensionUrl), "utf8"),
    readFile(new URL("background.js", extensionUrl), "utf8"),
    readFile(new URL("content.js", extensionUrl), "utf8"),
  ]);

  assert.match(popup, /id="show-grid"/);
  assert.match(background, /showGrid/);
  assert.match(background, /frameId === 0/);
  assert.match(content, /createElement\("canvas"\)/);
  assert.match(content, /getContext\("2d"\)/);
  assert.match(content, /fillRect/);
  assert.match(content, /document\.documentElement\.prepend/);
  assert.match(content, /--ks-tty-cell-w/);
  assert.match(content, /--ks-tty-cell-h/);
  assert.match(content, /pointer-events", "none"/);
  assert.match(content, /querySelectorAll\("img, video, canvas, svg"\)/);
  assert.match(content, /restoreMedia/);
  assert.match(content, /GRID_INSETS/);
  assert.match(content, /margin-top/);
  assert.match(content, /padding-left/);
  assert.match(content, /row-gap/);
  assert.match(content, /restoreInsets/);
  assert.match(content, /MutationObserver/);
});
