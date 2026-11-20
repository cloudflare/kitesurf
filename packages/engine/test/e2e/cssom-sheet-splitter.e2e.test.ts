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
    '@supports "a\n{x{color:red}}',
    '@layer "a\n{x{color:red}}',
    '@layer "a\n;',
    '@keyframes "a\n{}',
    '@font-feature-values "a\n{}',
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

// The end of the sheet closes an open string, url, function and block, as in Chrome: the
// rule keeps its earlier declarations, and a later quote after a bad string still swallows
// the rest of the text.
test("an unclosed last rule is closed at the end of the sheet", async ({ browser }) => {
  for (const css of [
    '#t{margin-left:3px; content:"line one\nline two"; color:red}\n#t{color:blue}',
    '#t{margin-left:3px; content:"oops',
    "#t{margin-left:3px; background:url(a",
    "#t{margin-left:3px; --x:f(1",
    "@media all{#t{margin-left:3px",
    '#t{margin-left:3px; content:"a\\',
    "#t{margin-left:3px; background:x\\",
    "#t{margin-left:3px; --x:[",
    "#t{margin-left:3px; --x:f({",
    "#t{margin-left:3px; --x:a\\\nb",
    "#t{margin-left:3px; --x:f([{",
  ]) {
    const page = await browser.newPage();
    try {
      await setContent(page, `<style id=s></style><p id=t>x</p>`);
      const result = await page.evaluate(`(() => {
        const s = document.getElementById("s");
        s.textContent = ${JSON.stringify(css)};
        const rules = s.sheet.cssRules.length;
        s.sheet.insertRule("#t{padding-right:4px}", s.sheet.cssRules.length);
        // insertRule takes the same unclosed text as a rule of its own.
        const sheet = new CSSStyleSheet();
        sheet.insertRule(${JSON.stringify(css)});
        const inserted = sheet.cssRules[0].cssText.includes("margin-left: 3px");
        const t = getComputedStyle(document.getElementById("t"));
        return { rules, inserted, color: t.color, margin: t.marginLeft, padding: t.paddingRight };
      })()`);
      expect(result, css).toEqual({
        rules: 1,
        inserted: true,
        color: "rgb(0, 0, 0)",
        margin: "3px",
        padding: "4px",
      });
    } finally {
      await page.close();
    }
  }
}, 60_000);

// Inside an open ( or [ a } is plain text, so the rule stays open and swallows the rest; a {
// inside a prelude's ( is not a rule block. Results match Chrome.
test("a brace inside an open block does not end the rule", async ({ browser }) => {
  for (const [css, margin] of [
    ["#t{margin-left:3px; --x:f(} #t{color:red}", "3px"],
    ["#t{margin-left:3px; --x:[} #t{color:red}", "3px"],
    ["#t(a{color:red}) #t{margin-left:3px}", "0px"],
    ["#t{--x:f([) ; margin-left:3px} #t{color:red}", "0px"],
  ]) {
    const page = await browser.newPage();
    try {
      await setContent(page, `<style id=s></style><p id=t>x</p>`);
      const result = await page.evaluate(`(() => {
        const s = document.getElementById("s");
        s.textContent = ${JSON.stringify(css)};
        s.sheet.insertRule("#t{padding-right:4px}", s.sheet.cssRules.length);
        const t = getComputedStyle(document.getElementById("t"));
        return { color: t.color, margin: t.marginLeft, padding: t.paddingRight };
      })()`);
      expect(result, css).toEqual({ color: "rgb(0, 0, 0)", margin, padding: "4px" });
    } finally {
      await page.close();
    }
  }
}, 60_000);

// A stray } at the top level starts an invalid rule, as in Chrome; the rules around it stay.
test("a stray closing brace drops only the rule after it", async ({ page }) => {
  await setContent(page, `<style id=s></style><p id=t>x</p>`);
  const result = await page.evaluate(`(() => {
    const s = document.getElementById("s");
    s.textContent = "#a{color:red}}#t{margin-left:3px} #t{color:rgb(1, 2, 3)}";
    s.sheet.insertRule("#t{padding-right:4px}", s.sheet.cssRules.length);
    const t = getComputedStyle(document.getElementById("t"));
    return { color: t.color, margin: t.marginLeft, padding: t.paddingRight };
  })()`);
  expect(result).toEqual({ color: "rgb(1, 2, 3)", margin: "0px", padding: "4px" });
}, 60_000);

// A brace inside an unquoted url does not end the rule; after # or @, url( is not a url.
test("url token boundaries in the rule splitter", async ({ browser }) => {
  for (const css of [
    "#t{background-image:url(data:,a/*}*/b)}",
    "#t{background-image:url(data:,a}b)}",
    "#t{--x:#url(/* ) } */ )}",
    "#t{--x:@url(/* ) } */ )}",
  ]) {
    const page = await browser.newPage();
    try {
      await setContent(page, `<style id=s></style><p id=t>x</p>`);
      const result = await page.evaluate(`(() => {
        const s = document.getElementById("s");
        s.textContent = ${JSON.stringify(css + " #t{margin-left:3px}")};
        const rules = s.sheet.cssRules.length;
        s.sheet.insertRule("#t{padding-right:4px}", s.sheet.cssRules.length);
        const t = getComputedStyle(document.getElementById("t"));
        return { rules, margin: t.marginLeft, padding: t.paddingRight };
      })()`);
      expect(result, css).toEqual({ rules: 2, margin: "3px", padding: "4px" });
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
