// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("the sheet splitter keeps rules after an unquoted url holding [ and a newline-ended string", async ({
  page,
}) => {
  await setContent(
    page,
    `<style id=a>@import url(a[.css);\n#t{color:red}</style>` +
      `<style id=b>x{content:"oops\n} /* } */ #t{margin-left:3px}</style>` +
      `<style id=c></style><p id=t>y</p>`,
  );
  const r = await page.evaluate(`(() => {
    // The HTML parser folds CRLF, so write the escaped CRLF line break from script.
    const escapedCrlf = String.fromCharCode(92, 13, 10);
    document.getElementById("c").textContent =
      'y{content:"a' + escapedCrlf + 'b"} #t{padding-left:2px}';
    const sel = (id) => Array.from(document.getElementById(id).sheet.cssRules,
      (r) => r.selectorText || r.constructor.name);
    const t = getComputedStyle(document.getElementById("t"));
    return {
      a: sel("a"),
      b: sel("b"),
      c: sel("c"),
      color: t.color,
      margin: t.marginLeft,
      padding: t.paddingLeft,
    };
  })()`);
  expect(r).toEqual({
    a: ["CSSImportRule", "#t"],
    b: ["x", "#t"],
    c: ["y", "#t"],
    color: "rgb(255, 0, 0)",
    margin: "3px",
    padding: "2px",
  });
}, 60_000);

// The mirror rewrites the <style> text from the split rules. A misread tail became a rule whose
// text opened a comment or block in Blitz and swallowed every rule inserted after it.
test("a rule inserted after an open comment or [ block applies", async ({ browser }) => {
  for (const css of ["#t{color:red} /*/ x{}", "#t{color:red} a[href{}"]) {
    const page = await browser.newPage();
    try {
      await setContent(page, `<style id=s>${css}</style><p id=t>x</p>`);
      const result = await page.evaluate(`(() => {
        const sheet = document.getElementById("s").sheet;
        sheet.insertRule("#t{color:rgb(1,2,3)}", sheet.cssRules.length);
        sheet.insertRule("#t{margin-left:4px}", sheet.cssRules.length);
        const t = getComputedStyle(document.getElementById("t"));
        return { color: t.color, margin: t.marginLeft };
      })()`);
      expect(result, css).toEqual({ color: "rgb(1, 2, 3)", margin: "4px" });
    } finally {
      await page.close();
    }
  }
}, 60_000);
