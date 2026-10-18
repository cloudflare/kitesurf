// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import { expect, test } from "../harness";

test("css-ua-styles-demo", async ({ page }) => {
  const HTML = `<!doctype html>
<html><body><div id="x">hello</div></body></html>`;

  const session = await page.target().createCDPSession();

  let uaHeader = null;
  session.on("CSS.styleSheetAdded", (p) => {
    if (p.header.origin === "user-agent") uaHeader = p.header;
  });

  const tree = await session.send("Page.getFrameTree");
  await session.send("Page.setDocumentContent", {
    frameId: tree.frameTree.frame.id,
    html: HTML,
  });
  await sleep(150);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const uaDeadline = Date.now() + 5000;
  while (uaHeader === null && Date.now() < uaDeadline) {
    await sleep(10);
  }

  expect(
    uaHeader !== null,
    "CSS.styleSheetAdded emitted with origin:'user-agent' (no UA header captured)",
  ).toBeTruthy();

  expect(uaHeader.isInline, "UA header isInline === false").toBe(false);
  expect(uaHeader.ownerNode, "UA header has no ownerNode (sheet has no DOM owner)").toBeUndefined();
  expect(uaHeader.length > 1000, `UA header length > 0: got: ${uaHeader.length}`).toBeTruthy();

  const textR = await session.send("CSS.getStyleSheetText", {
    styleSheetId: uaHeader.styleSheetId,
  });
  expect(
    typeof textR.text === "string" && textR.text.length > 1000,
    `getStyleSheetText returns UA body: length: ${textR.text?.length}`,
  ).toBeTruthy();
  expect(textR.text.includes("@namespace"), "UA text contains @namespace declaration").toBeTruthy();
  expect(
    /body\s*\{[^}]*display:\s*block/s.test(textR.text),
    "UA text contains the body { display: block } rule",
  ).toBeTruthy();

  const doc = await session.send("DOM.getDocument");
  function findByTag(root, tag) {
    const stack = [root];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      if ((n.nodeName || "").toLowerCase() === tag) return n;
      if (Array.isArray(n.children)) for (const c of n.children) stack.push(c);
    }
    return null;
  }
  const body = findByTag(doc.root, "body");
  const div = findByTag(doc.root, "div");
  expect(!!body && !!div, "located <body> and <div>").toBeTruthy();

  const bodyMatched = await session.send("CSS.getMatchedStylesForNode", {
    nodeId: body.nodeId,
  });
  const bodyUaRules = (bodyMatched.matchedCSSRules ?? []).filter(
    (m) => m.rule.origin === "user-agent",
  );
  expect(
    bodyUaRules.length > 0,
    `<body> matched-rules include UA defaults: total: ${bodyMatched.matchedCSSRules?.length}, UA: ${bodyUaRules.length}`,
  ).toBeTruthy();
  expect(
    bodyUaRules.some(
      (m) =>
        m.rule.selectorList.text === "body" &&
        m.rule.style.cssProperties.some((p) => p.name === "display" && p.value === "block"),
    ),
    "<body> UA rules include the `body { display: block; margin: 8px }` rule: selectors: " +
      JSON.stringify(bodyUaRules.map((m) => m.rule.selectorList.text)),
  ).toBeTruthy();

  const divMatched = await session.send("CSS.getMatchedStylesForNode", {
    nodeId: div.nodeId,
  });
  const divUaRules = (divMatched.matchedCSSRules ?? []).filter(
    (m) => m.rule.origin === "user-agent",
  );
  expect(divUaRules.length > 0, "<div> matched-rules include UA defaults").toBeTruthy();
  expect(
    divUaRules.some((m) =>
      m.rule.style.cssProperties.some((p) => p.name === "display" && p.value === "block"),
    ),
    "<div> UA rules include a rule setting `display: block`: UA rules: " +
      JSON.stringify(divUaRules.map((m) => m.rule.selectorList.text)),
  ).toBeTruthy();
});
