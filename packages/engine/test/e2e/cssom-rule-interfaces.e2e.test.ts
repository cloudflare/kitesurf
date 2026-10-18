// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

interface EvalResult {
  result?: { value?: unknown };
  exceptionDetails?: { exception?: { description?: string } };
}

test("CSSOM rules carry real interfaces, constraints and validation", async ({
  cdpSession: cdp,
}) => {
  const r = (await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const st = document.createElement("style");
      st.textContent = '@import url("a.css") layer(base) print;\\n' +
        'div > p { color: red; }\\n' +
        '@media screen { .x { color: blue; } }\\n' +
        '@font-palette-values --A { font-family: Bar; base-palette: 1; }';
      document.head.appendChild(st);
      const rr = st.sheet.cssRules;
      const err = (fn) => { try { fn(); return "ok"; } catch (e) { return e.name || "TypeError"; } };
      return JSON.stringify({
        names: Array.from(rr).map((x) => x.constructor.name),
        types: Array.from(rr).map((x) => x.type),
        importLayer: rr[0].layerName,
        selCanon: rr[1].selectorText,
        isGrouping: rr[2] instanceof CSSGroupingRule && rr[2] instanceof CSSRule,
        mediaChildParent: rr[2].cssRules[0].parentRule === rr[2],
        paletteName: rr[3].name,
        typeConst: rr[1].type === CSSRule.STYLE_RULE,
        groupHierarchy: err(() => rr[2].insertRule("@import url(x.css);")),
        insertArity: err(() => st.sheet.insertRule()),
        badSelector: err(() => st.sheet.insertRule("::before::selection { color: red; }")),
        escapedSelector: err(() => st.sheet.insertRule(".foo\\\\( { color: green; }", st.sheet.cssRules.length)),
        deleteOob: err(() => new CSSStyleSheet().deleteRule(0)),
        sheetBrand: st.sheet instanceof CSSStyleSheet,
        declBrand: rr[1].style instanceof CSSStyleDeclaration,
      });
    })()`,
    returnByValue: true,
  })) as EvalResult;
  expect(r.exceptionDetails).toBeFalsy();
  expect(JSON.parse(String(r.result?.value))).toEqual({
    names: ["CSSImportRule", "CSSStyleRule", "CSSMediaRule", "CSSFontPaletteValuesRule"],
    types: [3, 1, 4, 0],
    importLayer: "base",
    selCanon: "div > p",
    isGrouping: true,
    mediaChildParent: true,
    paletteName: "--A",
    typeConst: true,
    groupHierarchy: "HierarchyRequestError",
    insertArity: "TypeError",
    badSelector: "SyntaxError",
    escapedSelector: "ok",
    deleteOob: "IndexSizeError",
    sheetBrand: true,
    declBrand: true,
  });
}, 120_000);

test("stylesheet declarations stay in Stylo across CSSOM mutations", async ({
  cdpSession: cdp,
}) => {
  const r = (await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const st = document.createElement("style");
      const base = document.createElement("base");
      base.href = "https://example.test/assets/";
      document.head.appendChild(base);
      st.textContent = ':root { --space: 12px; }\\n' +
        '.box { margin: 10px; padding: var(--space); color: red; background-image: url(data:image/svg+xml;base64,abc); --Camel: 1; }\\n' +
        '@font-face { src: url(old.woff2); font-display: swap; font-family: Test; src: url(test.woff2); font-display: bogus; }\\n' +
        '@keyframes fade { from { opacity: .5 !important; color: blue; } }\\n' +
        '@page { size: A4; background-image: url(data:image/svg+xml;base64,abc); @top-left { content: "}"; } }';
      document.head.appendChild(st);
      const box = document.createElement("div");
      box.className = "box";
      document.body.appendChild(box);

      const rules = st.sheet.cssRules;
      const style = rules[1].style;
      const initial = {
        margin: style.margin,
        padding: style.padding,
        length: style.length,
        names: Array.from(style),
        cssText: style.cssText,
        backgroundImage: style.backgroundImage,
        fontSrc: rules[2].style.src,
        fontDisplay: rules[2].style.fontDisplay,
        fontNames: Array.from(rules[2].style),
        fontCssText: rules[2].style.cssText,
        keyframeOpacity: rules[3].cssRules[0].style.opacity,
        keyframePriority: rules[3].cssRules[0].style.getPropertyPriority("opacity"),
        pageSize: rules[4].style.size,
      };

      style.setProperty("color", "bogus");
      style.setProperty("color", "green", " important ");
      const colorAfterInvalidPriority = style.color;
      style.setProperty("background-color", "blue", "important");
      style.setProperty("background-image", "url(b.png)");
      rules[2].style.setProperty("font-weight", "400");
      const removed = style.removeProperty("margin");
      rules[3].cssRules[0].style.setProperty("opacity", ".2", "important");
      st.sheet.insertRule('.inserted { padding: var(--space); }', st.sheet.cssRules.length);
      const inserted = st.sheet.cssRules[5].style;
      st.sheet.insertRule('.mixed { margin-top: 1px !important; margin-right: 2px; margin-bottom: 3px; margin-left: 4px; }', st.sheet.cssRules.length);
      const mixed = st.sheet.cssRules[6].style;
      const mixedBefore = mixed.getPropertyValue("margin");
      mixed.removeProperty("margin");
      return JSON.stringify({
        initial,
        colorAfterInvalid: style.color,
        background: style.backgroundColor,
        backgroundPriority: style.getPropertyPriority("background-color"),
        backgroundImage: style.backgroundImage,
        colorAfterInvalidPriority,
        removed,
        marginAfterRemove: style.margin,
        insertedPadding: inserted.padding,
        insertedCssText: inserted.cssText,
        mirroredText: st.textContent,
        computedPadding: getComputedStyle(box).paddingTop,
        fontSrcAfterMirror: st.sheet.cssRules[2].style.src,
        fontWeightAfterMirror: st.sheet.cssRules[2].style.fontWeight,
        pageSizeAfterMirror: st.sheet.cssRules[4].style.size,
        pageCssTextAfterMirror: st.sheet.cssRules[4].cssText,
        keyframeOpacityAfterMutation: st.sheet.cssRules[3].cssRules[0].style.opacity,
        mixedBefore,
        mixedAfter: mixed.margin,
        mixedLengthAfter: mixed.length,
      });
    })()`,
    returnByValue: true,
  })) as EvalResult;
  expect(r.exceptionDetails).toBeFalsy();
  const value = JSON.parse(String(r.result?.value));
  expect(value.initial).toMatchObject({
    margin: "10px",
    padding: "var(--space)",
    length: 5,
    names: ["margin", "padding", "color", "background-image", "--Camel"],
    backgroundImage: 'url("data:image/svg+xml;base64,abc")',
    fontSrc: 'url("test.woff2")',
    fontDisplay: "swap",
    fontNames: ["font-display", "font-family", "src"],
    keyframeOpacity: "",
    keyframePriority: "",
    pageSize: "a4",
  });
  expect(value.initial.cssText).toContain("margin: 10px");
  expect(value.initial.cssText).toContain("padding: var(--space)");
  expect(value.colorAfterInvalid).toBe("red");
  expect(value.background).toBe("blue");
  expect(value.backgroundPriority).toBe("important");
  expect(value.backgroundImage).toContain("b.png");
  expect(value.colorAfterInvalidPriority).toBe("red");
  expect(value.removed).toBe("10px");
  expect(value.marginAfterRemove).toBe("");
  expect(value.insertedPadding).toBe("var(--space)");
  expect(value.insertedCssText).toContain("padding: var(--space)");
  expect(value.mirroredText).toContain('src: url("test.woff2")');
  expect(value.computedPadding).toBe("12px");
  expect(value.fontSrcAfterMirror).toBe('url("test.woff2")');
  expect(value.initial.fontCssText.indexOf("font-display")).toBeLessThan(
    value.initial.fontCssText.indexOf("font-family"),
  );
  expect(value.initial.fontCssText.indexOf("font-family")).toBeLessThan(
    value.initial.fontCssText.indexOf("src"),
  );
  expect(value.initial.fontCssText.endsWith(";")).toBe(true);
  expect(value.pageSizeAfterMirror).toBe("a4");
  expect(value.fontWeightAfterMirror).toBe("400");
  expect(value.pageCssTextAfterMirror).toContain('@top-left { content: "}"; }');
  expect(value.keyframeOpacityAfterMutation).toBe("");
  expect(value.mixedBefore).toBe("");
  expect(value.mixedAfter).toBe("");
  expect(value.mixedLengthAfter).toBe(0);
}, 120_000);
