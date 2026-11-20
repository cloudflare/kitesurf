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
    const a = sel("a");
    const b = sel("b");
    const c = sel("c");
    // The rebuilt text must keep the newline that ends the bad string, or the string takes
    // the closing brace and every rule after it.
    const sheetB = document.getElementById("b").sheet;
    sheetB.insertRule("#t{padding-right:4px}", sheetB.cssRules.length);
    const t = getComputedStyle(document.getElementById("t"));
    return {
      a,
      b,
      c,
      color: t.color,
      margin: t.marginLeft,
      padding: t.paddingLeft,
      paddingRight: t.paddingRight,
    };
  })()`);
  expect(r).toEqual({
    a: ["CSSImportRule", "#t"],
    b: ["x", "#t"],
    c: ["y", "#t"],
    color: "rgb(255, 0, 0)",
    margin: "3px",
    padding: "2px",
    paddingRight: "4px",
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

// Every place that trims or collapses rule text must keep the newline that ends a bad string.
test("a rule inserted after a newline-ended string in a prelude or at-rule applies", async ({
  browser,
}) => {
  for (const css of [
    'x"a\n{color:red}',
    '@media "a\n{x{color:red}}',
    '@page{content:"oops\n}',
    '@container{#q{content:"oops\n} }',
    '@font-palette-values --p{font-family:"oops\n}',
    'x{content:"oops\r\n}',
    'x"a\\ \n{color:red}',
    'x"a\\20 \n{color:red}',
    '@font-palette-values --p{font-family:"oops\\ \n}',
  ]) {
    const page = await browser.newPage();
    try {
      await setContent(page, `<style id=s></style><p id=t>x</p>`);
      const result = await page.evaluate(`(() => {
        const s = document.getElementById("s");
        s.textContent = ${JSON.stringify(css + " #t{margin-left:3px}")};
        s.sheet.insertRule("#t{padding-right:4px}", s.sheet.cssRules.length);
        const t = getComputedStyle(document.getElementById("t"));
        return { margin: t.marginLeft, padding: t.paddingRight };
      })()`);
      expect(result, css).toEqual({ margin: "3px", padding: "4px" });
    } finally {
      await page.close();
    }
  }
}, 60_000);

test("a medium appended with a newline-ended string keeps the rules after it", async ({ page }) => {
  await setContent(
    page,
    `<style id=s>@media all{x{color:red}} #t{margin-left:3px}</style><p id=t>x</p>`,
  );
  const result = await page.evaluate(`(() => {
    const sheet = document.getElementById("s").sheet;
    const media = sheet.cssRules[0].media;
    media.appendMedium('"a\\n');
    sheet.insertRule("#t{padding-right:4px}", sheet.cssRules.length);
    const t = getComputedStyle(document.getElementById("t"));
    const styles = { margin: t.marginLeft, padding: t.paddingRight };
    media.deleteMedium('"a\\n');
    return { ...styles, media: media.length };
  })()`);
  expect(result).toEqual({ margin: "3px", padding: "4px", media: 1 });
}, 60_000);

test("hex escapes keep their text when rule pieces are trimmed or collapsed", async ({ page }) => {
  await setContent(page, `<style id=s></style>`);
  const result = await page.evaluate(`(() => {
    const s = document.getElementById("s");
    s.textContent = "@media x\\\\31{} @container{a:\\\\31   b\\\\31\\n  c}";
    return Array.from(s.sheet.cssRules, (r) => r.media ? r.media.mediaText : r.cssText);
  })()`);
  expect(result).toEqual(["x\\31", "@container { a:\\31  b\\31  c }"]);
}, 60_000);

test("a /* inside an unquoted url is not a comment", async ({ page }) => {
  await setContent(
    page,
    `<style id=s>#t{background:url(a/*b)} #t{margin-left:3px}</style><p id=t>x</p>`,
  );
  const result = await page.evaluate(`(() => {
    const sheet = document.getElementById("s").sheet;
    const rules = sheet.cssRules.length;
    sheet.insertRule("#t{background:url(c/*d)}", sheet.cssRules.length);
    sheet.insertRule("#t{padding-right:4px}", sheet.cssRules.length);
    const t = getComputedStyle(document.getElementById("t"));
    return { rules, margin: t.marginLeft, padding: t.paddingRight };
  })()`);
  expect(result).toEqual({ rules: 2, margin: "3px", padding: "4px" });
}, 60_000);

// Outside a string a backslash before a newline is not an escape, so url( after it is a url.
test("a url after a backslash and newline keeps its /*", async ({ browser }) => {
  for (const brk of ["\\n", "\\r\\n", "\\r", "\\f"]) {
    const page = await browser.newPage();
    try {
      await setContent(page, `<style id=s></style><p id=t>x</p>`);
      const result = await page.evaluate(`(() => {
        const s = document.getElementById("s");
        s.textContent = "#t{--x:\\\\${brk}url(/*)} #t{margin-left:3px}";
        s.sheet.insertRule("#t{padding-right:4px}", s.sheet.cssRules.length);
        const t = getComputedStyle(document.getElementById("t"));
        return { margin: t.marginLeft, padding: t.paddingRight };
      })()`);
      expect(result, brk).toEqual({ margin: "3px", padding: "4px" });
    } finally {
      await page.close();
    }
  }
}, 60_000);

// A name that only ends in "url" is a plain function, so a /* inside it opens a comment.
test("a /* inside a function ending in url still opens a comment", async ({ browser }) => {
  for (const prefix of ["é", "😀", "\\u0000", "\\\\]", "\\\\0 "]) {
    const page = await browser.newPage();
    try {
      await setContent(page, `<style id=s></style><p id=t>x</p>`);
      const result = await page.evaluate(`(() => {
        const s = document.getElementById("s");
        s.textContent = "#t{--x:${prefix}url(/*} #t{margin-left:3px}";
        s.sheet.insertRule("#t{padding-right:4px}", s.sheet.cssRules.length);
        const t = getComputedStyle(document.getElementById("t"));
        return { margin: t.marginLeft, padding: t.paddingRight };
      })()`);
      expect(result, prefix).toEqual({ margin: "0px", padding: "4px" });
    } finally {
      await page.close();
    }
  }
}, 60_000);

test("a quoted comma does not split a media query", async ({ page }) => {
  await setContent(
    page,
    `<style id=s>@media all, (x: "a,b"){#t{margin-left:3px}}</style><p id=t>x</p>`,
  );
  const result = await page.evaluate(`(() => {
    const sheet = document.getElementById("s").sheet;
    const list = sheet.cssRules[0].media;
    const media = list.length;
    sheet.insertRule("#t{padding-right:4px}", sheet.cssRules.length);
    const t = getComputedStyle(document.getElementById("t"));
    list.mediaText = 'screen, (y: "c,d")';
    return { media, set: list.mediaText, margin: t.marginLeft, padding: t.paddingRight };
  })()`);
  expect(result).toEqual({ media: 2, set: 'screen, (y: "c,d")', margin: "3px", padding: "4px" });
}, 60_000);
