// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

interface EvalResult {
  result?: { value?: unknown };
  exceptionDetails?: { exception?: { description?: string } };
}

test("CSSPageRule / CSSMarginRule model @page correctly", async ({ cdpSession: cdp }) => {
  const r = (await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const st = document.createElement("style");
      st.textContent =
        '@page { margin: 10px 20px; }\\n' +
        '@page :left { @t\\\\6f p-left { margin-left: 5px; content: "}"; size: A4; } }\\n' +
        '@page bogus:visited { margin: 1px; }\\n' +
        '@page --dashed { margin: 1px; }\\n' +
        '@page name1\\\\{\\\\}name2, Foo:first:LEFT {\\n' +
        '  margin: 2px;\\n' +
        '  @top-left { }\\n' +
        '  @page nested { size: letter; }\\n' +
        '  @font-face { font-family: x; }\\n' +
        '  @import url(x.css);\\n' +
        '  @bottom-right { margin-top: 3px }\\n' +
        '}\\n' +
        'h1 { display: block; }';
      document.head.appendChild(st);
      const h1 = document.createElement("h1");
      document.body.appendChild(h1);
      const rules = st.sheet.cssRules;
      const err = (fn) => { try { fn(); return "ok"; } catch (e) { return e.name || "TypeError"; } };
      const names = (rule) => Array.from(rule.cssRules).map((r) => r.name);

      const p0 = rules[0]; // @page { margin: 10px 20px; }
      const p1 = rules[1]; // @page :left { @t\\\\6f p-left {...} }
      const p2 = rules[2]; // @page name1\\{\\}name2, Foo:first:LEFT { ... }
      const marginRule = p1.cssRules[0];
      const initialRuleCount = rules.length;
      const p1InitialSel = p1.selectorText;
      const p2InitialNames = names(p2);
      const p2InitialCssText = p2.cssText;

      const insertStyleRule = err(() => p2.insertRule("div {}"));
      const insertNestedPage = err(() => p2.insertRule("@page {}"));
      const insertMedia = err(() => p2.insertRule("@media print {}"));
      const insertTwo = err(() => p2.insertRule("@top-left {} @top-right {}"));
      p2.insertRule("@top-right { margin-top: 1px }", p2.cssRules.length);
      p2.insertRule("@top-left {}", 0);
      const afterInserts = names(p2);
      p2.deleteRule(0);
      const afterDelete = names(p2);

      p1.selectorText = "bogus:visited";
      const invalidSelectorIgnored = p1.selectorText;
      p1.selectorText = "  A , b:FIRST ";
      const canonicalSelector = p1.selectorText;
      p1.selectorText = "";
      const emptySelector = p1.selectorText;
      const mirroredAfterMutation = st.textContent;

      const topLevelMargin = err(() => st.sheet.insertRule("@top-left {}"));
      const emptyComponent = err(() => st.sheet.insertRule("@page , {}"));
      const strayComma = err(() => st.sheet.insertRule("@page a, {}"));
      const i = st.sheet.insertRule("@page test1, Test2 { margin: 3px }", rules.length);
      const inserted = st.sheet.cssRules[i];

      return JSON.stringify({
        ruleCount: initialRuleCount,
        p0ctor: p0.constructor.name,
        p0type: p0.type === CSSRule.PAGE_RULE,
        p0sel: p0.selectorText,
        p0margins: [p0.style.marginTop, p0.style.marginRight, p0.style.marginBottom, p0.style.marginLeft],
        p0cssText: p0.cssText,
        p1sel: p1InitialSel,
        p1cssRulesLen: p1.cssRules.length,
        marginCtor: marginRule.constructor.name,
        marginType: marginRule.type === CSSRule.MARGIN_RULE,
        marginName: marginRule.name,
        marginParent: marginRule.parentRule === p1,
        marginSheet: marginRule.parentStyleSheet === st.sheet,
        marginLeft: marginRule.style.marginLeft,
        marginContent: marginRule.style.content,
        marginSize: marginRule.style.size,
        marginCssText: marginRule.cssText,
        p2sel: p2.selectorText,
        p2margin: p2.style.margin,
        p2InitialNames,
        p2InitialCssText,
        insertStyleRule, insertNestedPage, insertMedia, insertTwo,
        afterInserts, afterDelete,
        invalidSelectorIgnored, canonicalSelector, emptySelector,
        mirroredHasMarginRule: mirroredAfterMutation.includes('@top-left { margin-left: 5px; content: "}";'),
        mirroredHasNewSelector: mirroredAfterMutation.includes("@page { @top-left"),
        topLevelMargin, emptyComponent, strayComma,
        inserted: [inserted.constructor.name, inserted.selectorText, inserted.style.margin],
        h1PageOrientation: getComputedStyle(h1).getPropertyValue("page-orientation"),
        h1Display: getComputedStyle(h1).display,
      });
    })()`,
    returnByValue: true,
  })) as EvalResult;
  expect(r.exceptionDetails).toBeFalsy();
  const parsed = JSON.parse(String(r.result?.value));
  expect(parsed).toEqual({
    ruleCount: 4,
    p0ctor: "CSSPageRule",
    p0type: true,
    p0sel: "",
    p0margins: ["10px", "20px", "10px", "20px"],
    p0cssText: "@page { margin: 10px 20px; }",
    p1sel: ":left",
    p1cssRulesLen: 1,
    marginCtor: "CSSMarginRule",
    marginType: true,
    marginName: "top-left",
    marginParent: true,
    marginSheet: true,
    marginLeft: "5px",
    marginContent: '"}"',
    marginSize: "",
    marginCssText: '@top-left { margin-left: 5px; content: "}"; }',
    p2sel: "name1\\{\\}name2, Foo:first:left",
    p2margin: "2px",
    p2InitialNames: ["top-left", "bottom-right"],
    p2InitialCssText:
      "@page name1\\{\\}name2, Foo:first:left { margin: 2px; @top-left { } @bottom-right { margin-top: 3px; } }",
    insertStyleRule: "SyntaxError",
    insertNestedPage: "SyntaxError",
    insertMedia: "SyntaxError",
    insertTwo: "SyntaxError",
    afterInserts: ["top-left", "top-left", "bottom-right", "top-right"],
    afterDelete: ["top-left", "bottom-right", "top-right"],
    invalidSelectorIgnored: ":left",
    canonicalSelector: "A, b:first",
    emptySelector: "",
    mirroredHasMarginRule: true,
    mirroredHasNewSelector: true,
    topLevelMargin: "SyntaxError",
    emptyComponent: "SyntaxError",
    strayComma: "SyntaxError",
    inserted: ["CSSPageRule", "test1, Test2", "3px"],
    h1PageOrientation: "",
    h1Display: "block",
  });
}, 120_000);
