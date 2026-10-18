// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

const HTML = `<!doctype html>
<html>
<head><title>innerhtml-rebuild-probe</title></head>
<body>
  <div id="menu">
    <div id="buttons">
      <a id="multiplayer">Start Multiplayer</a>
      <a id="solo">Play Solo</a>
    </div>
  </div>
</body>
</html>`;

test("dom-innerhtml-rebuild-demo", async ({ page, cdpSession: session }) => {
  const events: Array<{ method: string; params: any }> = [];
  for (const m of [
    "DOM.childNodeInserted",
    "DOM.childNodeRemoved",
    "DOM.childNodeCountUpdated",
    "DOM.setChildNodes",
  ]) {
    session.on(m, (params) => events.push({ method: m, params }));
  }

  const frameTree = await session.send("Page.getFrameTree");
  await session.send("Page.setDocumentContent", {
    frameId: frameTree.frameTree.frame.id,
    html: HTML,
  });
  await session.send("DOM.enable");
  const doc = await session.send("DOM.getDocument");
  const findById = (n: any, id: string): any => {
    const attrs: string[] = n?.attributes ?? [];
    const i = attrs.indexOf("id");
    if (i >= 0 && attrs[i + 1] === id) return n;
    for (const c of n?.children ?? []) {
      const hit = findById(c, id);
      if (hit) return hit;
    }
    return null;
  };
  const buttons = findById(doc.root, "buttons");
  expect(buttons, "#buttons bound in the initial tree").toBeTruthy();

  events.length = 0;
  await page.evaluate(() => {
    setTimeout(() => {
      document.getElementById("buttons")!.innerHTML =
        '<a id="invite" href="https://example.com/room/42">invite link</a>';
    }, 100);
  });
  try {
    await expect
      .poll(
        () =>
          events.some(
            (e) => e.method === "DOM.setChildNodes" && e.params?.parentId === buttons.nodeId,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
  } catch {}

  const methods = events.map((e) => e.method);
  const countUpd = events.find(
    (e) => e.method === "DOM.childNodeCountUpdated" && e.params?.nodeId === buttons.nodeId,
  );
  expect(
    countUpd,
    `childNodeCountUpdated for #buttons arrived; saw: ${JSON.stringify(methods)}`,
  ).toBeTruthy();
  const rebind = events.find(
    (e) => e.method === "DOM.setChildNodes" && e.params?.parentId === buttons.nodeId,
  );
  expect(
    rebind,
    `setChildNodes rebind for #buttons arrived; saw: ${JSON.stringify(methods)}`,
  ).toBeTruthy();
  const freshChildren: any[] = rebind?.params?.nodes ?? [];
  const invite = freshChildren.find((n) => {
    const attrs: string[] = n?.attributes ?? [];
    const i = attrs.indexOf("id");
    return i >= 0 && attrs[i + 1] === "invite";
  });
  expect(
    invite,
    `fresh children carry A#invite: ${JSON.stringify(freshChildren).slice(0, 300)}`,
  ).toBeTruthy();
  expect(invite?.nodeName).toBe("A");
});
