// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const PNG_2x2 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DwnwEKGBgYGABQfgP9Qd1EnQAAAABJRU5ErkJggg==";

test("a data: src fires load on a detached image, and error when undecodable", async ({ page }) => {
  await setContent(page, "<body></body>");
  const got = await page.evaluate(`new Promise((resolve) => {
    const out = {};
    const settle = (key, img, type) => {
      out[key] = type + ":" + img.naturalWidth + ":" + img.complete;
      if (Object.keys(out).length === 2) resolve(out);
    };
    const ok = new Image();
    ok.onload = () => settle("ok", ok, "load");
    ok.onerror = () => settle("ok", ok, "error");
    ok.src = "data:image/png;base64,${PNG_2x2}";
    const bad = new Image();
    bad.onload = () => settle("bad", bad, "load");
    bad.onerror = () => settle("bad", bad, "error");
    bad.src = "data:image/png;base64,bm90IGFuIGltYWdl";
    setTimeout(() => resolve(out), 5000);
  })`);
  expect(got).toEqual({ ok: "load:2:true", bad: "error:0:true" });
});
