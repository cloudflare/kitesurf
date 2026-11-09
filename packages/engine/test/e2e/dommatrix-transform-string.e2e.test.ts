// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// DOMMatrix accepts a CSS transform string as well as a number sequence.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (function () {
    var m = new DOMMatrix("matrix(1, 2, 3, 4, 5, 6)");
    var m3 = new DOMMatrix("matrix3d(1,0,0,0, 0,1,0,0, 0,0,1,0, 7,8,9,1)");
    var none = new DOMMatrix("none");
    globalThis.__matrixReport = JSON.stringify({
      m2d: [m.a, m.b, m.c, m.d, m.e, m.f],
      is2D: m.is2D,
      m3d: [m3.m41, m3.m42, m3.m43],
      noneIdentity: [none.a, none.e, none.f],
    });
  })();
</script>`;

test("DOMMatrix parses matrix and matrix3d strings", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__matrixReport")).toEqual({
    m2d: [1, 2, 3, 4, 5, 6],
    is2D: true,
    m3d: [7, 8, 9],
    noneIdentity: [1, 0, 0],
  });
}, 60_000);

// A string that is not a matrix is a parse error, not a sequence of characters.
const invalid = `<script>
  (function () {
    var out = {};
    for (var value of ["translateX(10px)", "foobar"]) {
      try {
        new DOMMatrix(value);
        out[value] = "ok";
      } catch (e) {
        out[value] = e.name;
      }
    }
    globalThis.__matrixInvalid = JSON.stringify(out);
  })();
</script>`;

test("DOMMatrix throws for a string that is not a matrix", async ({ page, cdpSession }) => {
  await setContent(page, invalid, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__matrixInvalid")).toEqual({
    "translateX(10px)": "SyntaxError",
    foobar: "SyntaxError",
  });
}, 60_000);
