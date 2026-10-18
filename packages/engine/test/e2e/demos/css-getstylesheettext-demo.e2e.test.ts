// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("css-getstylesheettext-demo", async ({ page }) => {
  const STYLE_BODY_V1 = "p#x { color: rgb(0, 128, 0); font-size: 24px; }";
  const STYLE_BODY_V2 = "p#x { color: rgb(255, 0, 0); }";
  const HTML = `<!doctype html>
<html>
<head><style id="s1">${STYLE_BODY_V1}</style></head>
<body><p id="x">hello</p></body>
</html>`;

  const session = await page.target().createCDPSession();

  let firstSheetId = null;
  let changedFired = false;
  const uaIds = new Set();
  session.on("CSS.styleSheetAdded", (p) => {
    if (p.header.origin === "user-agent") {
      uaIds.add(p.header.styleSheetId);
      return;
    }
    if (!firstSheetId) firstSheetId = p.header.styleSheetId;
  });
  session.on("CSS.styleSheetChanged", (p) => {
    if (uaIds.has(p.styleSheetId)) return;
    changedFired = true;
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
    `captured a styleSheetId from CSS.styleSheetAdded: got: ${firstSheetId}`,
  ).toBeTruthy();

  const r1 = await session.send("CSS.getStyleSheetText", {
    styleSheetId: firstSheetId,
  });
  expect(r1.text, "getStyleSheetText returns the <style> body verbatim").toBe(STYLE_BODY_V1);

  changedFired = false;
  await session.send("Runtime.evaluate", {
    expression: `(function(){
    const s = document.getElementById('s1');
    if (s) s.textContent = ${JSON.stringify(STYLE_BODY_V2)};
  })()`,
  });
  await expect
    .poll(() => changedFired, { timeout: 10_000 })
    .toBe(true)
    .catch(() => {});
  expect(changedFired, "styleSheetChanged fired after textContent mutation").toBe(true);

  const r2 = await session.send("CSS.getStyleSheetText", {
    styleSheetId: firstSheetId,
  });
  expect(r2.text, "getStyleSheetText returns the new body after mutation").toBe(STYLE_BODY_V2);

  const r3 = await session.send("CSS.getStyleSheetText", {
    styleSheetId: "this-id-does-not-exist",
  });
  expect(
    typeof r3.text === "string" && r3.text === "",
    "unknown styleSheetId returns empty text (not an error): got: " + JSON.stringify(r3),
  ).toBeTruthy();
});
