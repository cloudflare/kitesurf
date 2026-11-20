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

// A top-level ; ends only an at-rule statement. Before any other rule it is prelude text, so
// that rule is invalid, as in Chrome. An @page body is a declaration list and still splits.
test("a top-level ; ends only an at-rule statement", async ({ browser }) => {
  for (const [css, margin] of [
    ["#a{color:red}}; #t{margin-left:7px}", "0px"],
    [";@media all{#t{margin-left:7px}}", "0px"],
    ["#t{margin-left:7px} x; @import url(a.css);", "7px"],
    ["@page{margin:1px; color:red} #t{margin-left:7px}", "7px"],
  ]) {
    const page = await browser.newPage();
    try {
      await setContent(page, `<style id=s></style><p id=t>x</p>`);
      const result = await page.evaluate(`(() => {
        const s = document.getElementById("s");
        s.textContent = ${JSON.stringify(css)};
        s.sheet.insertRule("#t{padding-right:4px}", s.sheet.cssRules.length);
        const t = getComputedStyle(document.getElementById("t"));
        return { margin: t.marginLeft, padding: t.paddingRight };
      })()`);
      expect(result, css).toEqual({ margin, padding: "4px" });
    } finally {
      await page.close();
    }
  }
}, 60_000);

// Punctuation inside a comment does not open a block in a media list, and the comment is not
// part of the entry. Matches Chrome.
test("a comment in media text does not stop the list from splitting", async ({ page }) => {
  await setContent(page, `<style id=s>@media all{#t{margin-left:3px}}</style><p id=t>x</p>`);
  const result = await page.evaluate(`(() => {
    const media = document.getElementById("s").sheet.cssRules[0].media;
    media.mediaText = "not all /* ( */, all";
    const items = Array.from(media);
    media.deleteMedium("all /* x */");
    const after = media.mediaText;
    media.mediaText = "not all /* , */ screen";
    const comma = media.length;
    media.mediaText = "screen /*x*/and (color)";
    const spaced = media.mediaText;
    media.deleteMedium("screen and (color)");
    const deleted = media.length;
    media.mediaText = "screen/**/and/**/(min-width:1px)";
    media.appendMedium("print /*");
    const margin = getComputedStyle(document.getElementById("t")).marginLeft;
    return { items, after, comma, spaced, deleted, text: media.mediaText, margin };
  })()`);
  expect(result).toEqual({
    items: ["not all", "all"],
    after: "not all",
    comma: 1,
    spaced: "screen and (color)",
    deleted: 0,
    text: "screen and (min-width:1px), print",
    margin: "3px",
  });
}, 60_000);

// Only CSS whitespace (space, tab, LF, CR, FF) collapses or trims in media text, as in Chrome.
// NBSP is a name character, so a query holding one stays invalid and its rule never applies.
// Kitesurf keeps the text as written where Chrome serializes an invalid query as "not all".
test("CSS whitespace collapses in media text; NBSP is kept", async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await setContent(page, `<style id=s>@media all{#t{margin-left:3px}}</style><p id=t>x</p>`);
    const result = await page.evaluate(`(() => {
      const media = document.getElementById("s").sheet.cssRules[0].media;
      media.mediaText = "print\\n\\n  and\\t(color)";
      const runs = media.mediaText;
      media.mediaText = "print\\u00a0and (color)";
      const inner = media.mediaText;
      media.mediaText = "\\u00a0all";
      const lead = media.length;
      return { runs, inner, lead, margin: getComputedStyle(document.getElementById("t")).marginLeft };
    })()`);
    expect(result).toEqual({
      runs: "print and (color)",
      inner: "print\u00a0and (color)",
      lead: 1,
      margin: "0px",
    });
  } finally {
    await page.close();
  }
  for (const css of [
    "@media \u00a0all{#t{margin-left:3px}}",
    "@media all\u00a0{#t{margin-left:3px}}",
    "\u00a0@media all{#t{margin-left:3px}}",
  ]) {
    const p = await browser.newPage();
    try {
      await setContent(p, `<style id=s></style><p id=t>x</p>`);
      const margin = await p.evaluate(`(() => {
        const s = document.getElementById("s");
        s.textContent = ${JSON.stringify(css)};
        s.sheet.insertRule("#t{padding-right:4px}", s.sheet.cssRules.length);
        return getComputedStyle(document.getElementById("t")).marginLeft;
      })()`);
      expect(margin, css).toBe("0px");
    } finally {
      await p.close();
    }
  }
}, 60_000);

// NBSP is a name character, so it stays in an @layer name before the `;`. Matches Chrome.
test("an NBSP before the ; stays in an @layer name", async ({ page }) => {
  await setContent(page, `<style id=s></style><p id=t>x</p>`);
  const names = await page.evaluate(`(() => {
    const s = document.getElementById("s");
    s.textContent = "@layer a\\u00a0;";
    return Array.from(s.sheet.cssRules[0].nameList);
  })()`);
  expect(names).toEqual(["a\u00a0"]);
}, 60_000);

// An @font-palette-values declaration needs an identifier name (escapes allowed): an open
// string or a lone hyphen is dropped, as in Chrome, so it cannot swallow the rules after it.
// NBSP is a name character, so `font-family\u00a0` is an unknown descriptor, never font-family.
// Kitesurf keeps unknown descriptors where Chrome drops them (that predates this test).
test("a non-identifier @font-palette-values descriptor name is dropped", async ({ browser }) => {
  for (const [css, body] of [
    ['@font-palette-values --p{"bad\n:x}', ""],
    ["@font-palette-values --p{-1foo:x}", ""],
    ["@font-palette-values --p{-:x}", ""],
    ["@font-palette-values --p{font-fam\\69 ly:x}", "font-fam\\69 ly: x; "],
    ["@font-palette-values --p{font-fam\\69\vly:x}", ""],
    ["@font-palette-values --p{font-family\u00a0:x}", "font-family\u00a0: x; "],
  ]) {
    const page = await browser.newPage();
    try {
      await setContent(page, `<style id=s></style><p id=t>x</p>`);
      const result = await page.evaluate(`(() => {
        const s = document.getElementById("s");
        s.textContent = ${JSON.stringify(css + " #t{margin-left:3px}")};
        s.sheet.insertRule("#t{padding-right:4px}", s.sheet.cssRules.length);
        const t = getComputedStyle(document.getElementById("t"));
        return { text: s.sheet.cssRules[0].cssText, margin: t.marginLeft, padding: t.paddingRight };
      })()`);
      const text = "@font-palette-values --p { " + body + "}";
      expect(result, css).toEqual({ text, margin: "3px", padding: "4px" });
    } finally {
      await page.close();
    }
  }
}, 60_000);

// The same rule holds for replaceSync: the rule after a stray `};` never applies, as in Chrome.
test("a ; before a rule drops it in replaceSync", async ({ page }) => {
  await setContent(page, `<p id=t>x</p>`);
  const margin = await page.evaluate(`(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("#a{color:red}}; #t{margin-left:7px}");
    document.adoptedStyleSheets = [sheet];
    return getComputedStyle(document.getElementById("t")).marginLeft;
  })()`);
  expect(margin).toBe("0px");
}, 60_000);

// A ; inside a block or url is part of an @font-palette-values value, so the serialized
// value never leaves a block open. Results match Chrome.
test("an @font-palette-values value keeps a ; inside a block", async ({ browser }) => {
  for (const [css, margin] of [
    ["@font-palette-values --p{font-family:(a;b", "0px"],
    ["@font-palette-values --p{font-family:(a;b)} #t{margin-left:3px}", "3px"],
    ["@font-palette-values --p{font-family:[a;b]} #t{margin-left:3px}", "3px"],
    ["@font-palette-values --p{font-family:url(a;b)} #t{margin-left:3px}", "3px"],
    ['@font-palette-values --p{font-family:"a;b"} #t{margin-left:3px}', "3px"],
  ]) {
    const page = await browser.newPage();
    try {
      await setContent(page, `<style id=s></style><p id=t>x</p>`);
      const result = await page.evaluate(`(() => {
        const s = document.getElementById("s");
        s.textContent = ${JSON.stringify(css)};
        s.sheet.insertRule("#t{padding-right:4px}", s.sheet.cssRules.length);
        const t = getComputedStyle(document.getElementById("t"));
        return { margin: t.marginLeft, padding: t.paddingRight };
      })()`);
      expect(result, css).toEqual({ margin, padding: "4px" });
    } finally {
      await page.close();
    }
  }
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
