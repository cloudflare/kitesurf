// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import { expect, test } from "../harness";

test("css-inherited-styles-demo", async ({ page }) => {
  const STYLE_TEXT =
    "html { font-family: serif; }\n" +
    "body { background-color: yellow; }\n" +
    "body { color: rgb(0, 128, 0); }\n" +
    ".bb { line-height: 1.5; }\n" +
    ".container { padding: 10px; }\n" +
    ".container { font-size: 16px; }\n" +
    "p#x { margin-top: 5px; }";
  const HTML = `<!doctype html>
<html><head><style>${STYLE_TEXT}</style></head>
<body class="bb"><div class="container"><p id="x">hello</p></div></body>
</html>`;

  const session = await page.target().createCDPSession();

  let authorSheetSeen = false;
  session.on("CSS.styleSheetAdded", (p) => {
    if (p.header.origin === "regular") authorSheetSeen = true;
  });

  const tree = await session.send("Page.getFrameTree");
  await session.send("Page.setDocumentContent", {
    frameId: tree.frameTree.frame.id,
    html: HTML,
  });
  await sleep(150);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const sheetDeadline = Date.now() + 5000;
  while (!authorSheetSeen && Date.now() < sheetDeadline) {
    await sleep(10);
  }

  const doc = await session.send("DOM.getDocument", { depth: -1 });
  function findById(root, id) {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      const i = (n.attributes || []).indexOf("id");
      if (i >= 0 && (n.attributes || [])[i + 1] === id) return n;
      if (Array.isArray(n.children)) for (const c of n.children) stack.push(c);
    }
    return null;
  }
  const pNode = findById(doc.root, "x");
  expect(!!pNode, "located <p id=x>").toBeTruthy();

  const r = await session.send("CSS.getMatchedStylesForNode", {
    nodeId: pNode.nodeId,
  });

  const authorDirect = (r.matchedCSSRules ?? []).filter((m) => m.rule.origin === "regular");
  expect(
    authorDirect.length === 1 && authorDirect[0].rule.selectorList.text === "p#x",
    `author matchedCSSRules has the p#x rule: got: ${JSON.stringify(authorDirect.map((m) => m.rule.selectorList.text))}`,
  ).toBeTruthy();

  expect(
    Array.isArray(r.inherited),
    `inherited is an array: got: ${typeof r.inherited}`,
  ).toBeTruthy();

  expect(
    r.inherited?.length === 3,
    `inherited has 3 ancestor entries: got ${r.inherited?.length} entries: ${JSON.stringify(r.inherited?.map((i) => i.matchedCSSRules.map((m) => m.rule.selectorList.text)))}`,
  ).toBeTruthy();

  if (r.inherited?.length === 3) {
    const onlyAuthor = (entry) => entry.matchedCSSRules.filter((m) => m.rule.origin === "regular");
    const [div, body, html] = r.inherited.map((e) => ({ matchedCSSRules: onlyAuthor(e) }));

    expect(
      div.matchedCSSRules.length === 1 &&
        div.matchedCSSRules[0].rule.selectorList.text === ".container" &&
        div.matchedCSSRules[0].rule.style.cssProperties.some((p) => p.name === "font-size"),
      `inherited[0] has .container { font-size } only (padding filtered): got: ${JSON.stringify(div.matchedCSSRules.map((m) => ({ sel: m.rule.selectorList.text, props: m.rule.style.cssProperties.map((p) => p.name) })))}`,
    ).toBeTruthy();

    expect(
      body.matchedCSSRules.length === 2,
      `inherited[1] has body{color} and .bb{line-height}: got: ${JSON.stringify(body.matchedCSSRules.map((m) => ({ sel: m.rule.selectorList.text, props: m.rule.style.cssProperties.map((p) => p.name) })))}`,
    ).toBeTruthy();
    const bodyRuleNames = body.matchedCSSRules.map((m) => m.rule.selectorList.text);
    expect(
      bodyRuleNames.includes("body") && bodyRuleNames.includes(".bb"),
      "inherited[1] body rule that survived is the one with color",
    ).toBeTruthy();

    expect(
      html.matchedCSSRules.length === 1 &&
        html.matchedCSSRules[0].rule.selectorList.text === "html" &&
        html.matchedCSSRules[0].rule.style.cssProperties.some((p) => p.name === "font-family"),
      `inherited[2] has html { font-family }: got: ${JSON.stringify(html.matchedCSSRules.map((m) => ({ sel: m.rule.selectorList.text, props: m.rule.style.cssProperties.map((p) => p.name) })))}`,
    ).toBeTruthy();
  }
});
