// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { setTimeout as sleep } from "node:timers/promises";

import { expect, test } from "../harness";

test("css-stylesheet-added-demo", async ({ page }) => {
  const HTML_TWO_SHEETS = `<!doctype html>
<html>
<head>
  <style id="s1">p#a { color: rgb(255, 0, 0); }</style>
  <style id="s2">p#b { color: rgb(0, 128, 0); }</style>
</head>
<body><p id="a">red</p><p id="b">green</p></body>
</html>`;

  const HTML_ONE_SHEET = `<!doctype html>
<html>
<head>
  <style>p { color: rgb(0, 0, 255); }</style>
</head>
<body><p>blue</p></body>
</html>`;

  const session = await page.target().createCDPSession();

  const events = [];
  const uaSheetIds = new Set();
  session.on("CSS.styleSheetAdded", (p) => {
    if (p.header.origin === "user-agent") {
      uaSheetIds.add(p.header.styleSheetId);
      return;
    }
    events.push({
      kind: "added",
      id: p.header.styleSheetId,
      isInline: p.header.isInline,
      length: p.header.length,
      ownerNode: p.header.ownerNode,
    });
  });
  session.on("CSS.styleSheetChanged", (p) => {
    if (uaSheetIds.has(p.styleSheetId)) return;
    events.push({ kind: "changed", id: p.styleSheetId });
  });
  session.on("CSS.styleSheetRemoved", (p) => {
    if (uaSheetIds.has(p.styleSheetId)) {
      uaSheetIds.delete(p.styleSheetId);
      return;
    }
    events.push({ kind: "removed", id: p.styleSheetId });
  });

  const tree = await session.send("Page.getFrameTree");
  await session.send("Page.setDocumentContent", {
    frameId: tree.frameTree.frame.id,
    html: HTML_TWO_SHEETS,
  });
  await sleep(120);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  await sleep(120);

  const initialAdded = events.filter((e) => e.kind === "added");
  expect(
    initialAdded.length === 2,
    `CSS.enable emits one styleSheetAdded per <style> in doc: got ${initialAdded.length}: ${JSON.stringify(initialAdded.map((e) => e.id))}`,
  ).toBeTruthy();
  expect(
    initialAdded.every((e) => e.isInline === true),
    "headers are isInline:true",
  ).toBeTruthy();
  expect(
    initialAdded.every((e) => typeof e.length === "number" && e.length > 0),
    "headers carry length matching the <style> body",
  ).toBeTruthy();
  const firstSheetId = initialAdded[0]?.id;
  expect(typeof firstSheetId === "string", "first sheetId is a string").toBeTruthy();

  events.length = 0;
  await session.send("Runtime.evaluate", {
    expression: `(function(){
    const s = document.createElement('style');
    s.textContent = 'p#c { color: rgb(128, 0, 128); }';
    document.head.appendChild(s);
  })()`,
  });
  await sleep(150);
  const addedAfterAppend = events.filter((e) => e.kind === "added");
  expect(
    addedAfterAppend.length === 1,
    `appending a new <style> emits one styleSheetAdded: got events: ${JSON.stringify(events)}`,
  ).toBeTruthy();
  const _thirdSheetId = addedAfterAppend[0]?.id;

  events.length = 0;
  await session.send("Runtime.evaluate", {
    expression: `(function(){
    const s = document.getElementById('s2');
    if (s) s.remove();
  })()`,
  });
  await sleep(150);
  const removedAfterDelete = events.filter((e) => e.kind === "removed");
  expect(
    removedAfterDelete.length === 1,
    `removing a <style> emits one styleSheetRemoved: got events: ${JSON.stringify(events)}`,
  ).toBeTruthy();

  events.length = 0;
  await session.send("Runtime.evaluate", {
    expression: `(function(){
    const s = document.getElementById('s1');
    if (s) s.textContent = 'p#a { color: rgb(0, 0, 0); }';
  })()`,
  });
  await sleep(150);
  const changedAfterEdit = events.filter((e) => e.kind === "changed");
  expect(
    changedAfterEdit.length === 1,
    `mutating <style>.textContent emits one styleSheetChanged: got events: ${JSON.stringify(events)}`,
  ).toBeTruthy();
  expect(
    changedAfterEdit[0]?.id === firstSheetId,
    `styleSheetChanged carries the SAME id as the original add: was ${firstSheetId}, got ${changedAfterEdit[0]?.id}`,
  ).toBeTruthy();

  events.length = 0;
  await session.send("Page.setDocumentContent", {
    frameId: tree.frameTree.frame.id,
    html: HTML_ONE_SHEET,
  });
  await sleep(200);

  const removedAfterNav = events.filter((e) => e.kind === "removed");
  const addedAfterNav = events.filter((e) => e.kind === "added");
  expect(
    removedAfterNav.length === 2,
    `navigate emits styleSheetRemoved for each old sheet: got ${removedAfterNav.length} removed: ${JSON.stringify(removedAfterNav.map((e) => e.id))}`,
  ).toBeTruthy();
  expect(
    addedAfterNav.length === 1,
    `navigate emits styleSheetAdded for each new sheet: got ${addedAfterNav.length} added: ${JSON.stringify(addedAfterNav.map((e) => e.id))}`,
  ).toBeTruthy();
});
