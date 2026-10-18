// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("css-matched-styles-demo", async ({ page }) => {
  const STYLE_TEXT =
    "p#x { color: rgb(0, 128, 0); font-size: 24px; margin-top: 10px; }\n" +
    "p.foo { font-weight: bold; }\n" +
    "body p, body span { padding: 5px; }\n" +
    ".nope { display: none; }";
  const HTML = `<!doctype html>
<html><head><style>${STYLE_TEXT}</style></head>
<body><p id="x" class="foo">hello</p></body></html>`;

  const session = await page.target().createCDPSession();

  let firstSheetId = null;
  session.on("CSS.styleSheetAdded", (p) => {
    if (p.header.origin === "user-agent") return;
    if (!firstSheetId) firstSheetId = p.header.styleSheetId;
  });

  const tree = await session.send("Page.getFrameTree");
  await session.send("Page.setDocumentContent", {
    frameId: tree.frameTree.frame.id,
    html: HTML,
  });
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  await expect
    .poll(() => firstSheetId, { timeout: 10_000 })
    .toBeTruthy()
    .catch(() => {});

  expect(
    typeof firstSheetId === "string" && firstSheetId.length > 0,
    "captured styleSheetId from CSS.styleSheetAdded",
  ).toBeTruthy();

  const doc = await session.send("DOM.getDocument");
  function findById(root, wantId) {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      const i = (n.attributes || []).indexOf("id");
      if (i >= 0 && (n.attributes || [])[i + 1] === wantId) return n;
      if (Array.isArray(n.children)) for (const c of n.children) stack.push(c);
    }
    return null;
  }
  const pNode = findById(doc.root, "x");
  expect(!!pNode, "located <p id=x> in DOM").toBeTruthy();

  const r = await session.send("CSS.getMatchedStylesForNode", {
    nodeId: pNode.nodeId,
  });

  expect(
    Array.isArray(r.matchedCSSRules),
    `matchedCSSRules is an array: got: ${typeof r.matchedCSSRules}`,
  ).toBeTruthy();
  const authorRules = (r.matchedCSSRules ?? []).filter((m) => m.rule.origin === "regular");
  expect(
    authorRules.length === 3,
    `3 author matched rules (p#x, p.foo, body p,body span): got ${authorRules.length}: ${JSON.stringify(authorRules.map((m) => m.rule.selectorList.text))}`,
  ).toBeTruthy();

  const uaRules = (r.matchedCSSRules ?? []).filter((m) => m.rule.origin === "user-agent");
  expect(
    uaRules.length > 0,
    `UA rules also matched (paragraph defaults): got ${uaRules.length} UA rules`,
  ).toBeTruthy();

  if (authorRules.length === 3) {
    const [r0, _r1, r2] = authorRules;
    expect(
      r0.rule.selectorList.text === "p#x",
      `rule[0].selectorList.text === 'p#x': got: ${JSON.stringify(r0.rule.selectorList.text)}`,
    ).toBeTruthy();
    expect(
      Array.isArray(r0.matchingSelectors) &&
        r0.matchingSelectors.length === 1 &&
        r0.matchingSelectors[0] === 0,
      `rule[0].matchingSelectors === [0]: got: ${JSON.stringify(r0.matchingSelectors)}`,
    ).toBeTruthy();
    expect(
      r0.rule.style.cssProperties?.length === 3,
      `rule[0].style.cssProperties has 3 entries (color, font-size, margin-top): got: ${JSON.stringify(r0.rule.style.cssProperties)}`,
    ).toBeTruthy();
    expect(
      r0.rule.style.cssProperties[0]?.name === "color",
      "rule[0].style.cssProperties[0].name === 'color'",
    ).toBeTruthy();
    expect(
      typeof r0.rule.style.cssProperties[0]?.value === "string" &&
        r0.rule.style.cssProperties[0].value.includes("0, 128, 0"),
      "rule[0].style.cssProperties[0].value contains '0, 128, 0'",
    ).toBeTruthy();
    expect(
      r0.rule.styleSheetId === firstSheetId,
      "rule[0] uses the captured author sheet id",
    ).toBeTruthy();
    expect(r0.rule.origin === "regular", "rule[0].rule.origin === 'regular'").toBeTruthy();

    expect(
      r2.rule.selectorList.selectors?.length === 2,
      `rule[2].selectorList has 2 selectors: got: ${JSON.stringify(r2.rule.selectorList.selectors)}`,
    ).toBeTruthy();
    expect(
      Array.isArray(r2.matchingSelectors) &&
        r2.matchingSelectors.length === 1 &&
        r2.matchingSelectors[0] === 0,
      `rule[2].matchingSelectors === [0]: got: ${JSON.stringify(r2.matchingSelectors)}`,
    ).toBeTruthy();

    let allRangesValid = true;
    for (const m of r.matchedCSSRules) {
      const range = m.rule.style.range;
      if (!range) {
        allRangesValid = false;
        break;
      }
      if (range.endLine < range.startLine) {
        allRangesValid = false;
        break;
      }
    }
    expect(
      allRangesValid,
      `every matched rule has a valid body range: ranges: ${JSON.stringify(r.matchedCSSRules.map((m) => m.rule.style.range))}`,
    ).toBeTruthy();

    const sel0 = r2.rule.selectorList.selectors[0];
    expect(
      sel0?.text === "body p",
      `rule[2].selectors[0].text === 'body p': got: ${JSON.stringify(sel0)}`,
    ).toBeTruthy();
    expect(
      sel0?.specificity &&
        typeof sel0.specificity.a === "number" &&
        typeof sel0.specificity.b === "number" &&
        typeof sel0.specificity.c === "number",
      `rule[2].selectors[0].specificity has 3 components: got: ${JSON.stringify(sel0?.specificity)}`,
    ).toBeTruthy();
  }

  const matchedSelectorTexts = (r.matchedCSSRules ?? []).map((m) => m.rule.selectorList.text);
  expect(
    !matchedSelectorTexts.includes(".nope"),
    "'.nope' rule is NOT matched (selector doesn't apply)",
  ).toBeTruthy();

  expect(
    Array.isArray(r.pseudoElements) && r.pseudoElements.length === 0,
    "pseudoElements is empty array",
  ).toBeTruthy();
  expect(
    Array.isArray(r.inherited) && r.inherited.length === 2,
    `inherited array has one entry per element ancestor: got ${r.inherited?.length}: ${JSON.stringify(r.inherited)}`,
  ).toBeTruthy();
  expect(
    Array.isArray(r.inherited) &&
      r.inherited.every((i) => Array.isArray(i.matchedCSSRules) && i.matchedCSSRules.length === 0),
    `inherited entries have zero matchedCSSRules (no inheritable rules match body/html here): got: ${JSON.stringify(r.inherited)}`,
  ).toBeTruthy();
});
