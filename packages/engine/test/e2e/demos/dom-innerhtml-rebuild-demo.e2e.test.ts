// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession } from "@cloudflare/puppeteer";

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

type RebuildNode = {
  nodeName?: string;
  nodeId?: number;
  attributes?: string[];
  children?: Array<{ nodeValue?: string | null }>;
};

type RebuildEvent = {
  method: string;
  params?: {
    parentId?: number;
    nodeId?: number;
    nodes?: RebuildNode[];
  };
};

function subscribeToRebuildEvents(session: CDPSession, events: RebuildEvent[]): void {
  const methods = [
    "DOM.childNodeInserted",
    "DOM.childNodeRemoved",
    "DOM.childNodeCountUpdated",
    "DOM.setChildNodes",
  ];
  for (const method of methods) {
    session.on(method, (params) => events.push({ method, params }));
  }
}

function isButtonRebind(event: RebuildEvent, nodeId: number): boolean {
  return event.method === "DOM.setChildNodes" && event.params?.parentId === nodeId;
}

function isButtonCountUpdate(event: RebuildEvent, nodeId: number): boolean {
  return event.method === "DOM.childNodeCountUpdated" && event.params?.nodeId === nodeId;
}

async function waitForButtonRebind(events: RebuildEvent[], nodeId: number): Promise<void> {
  await expect
    .poll(() => events.some((event) => isButtonRebind(event, nodeId)), { timeout: 10_000 })
    .toBe(true)
    .catch(() => {});
}

function assertRebuiltInvite(events: RebuildEvent[], nodeId: number): void {
  const methods = events.map((event) => event.method);
  const countUpdate = events.find((event) => isButtonCountUpdate(event, nodeId));
  expect(
    countUpdate,
    `childNodeCountUpdated for #buttons arrived; saw: ${JSON.stringify(methods)}`,
  ).toBeTruthy();

  const rebind = events.find((event) => isButtonRebind(event, nodeId));
  expect(
    rebind,
    `setChildNodes rebind for #buttons arrived; saw: ${JSON.stringify(methods)}`,
  ).toBeTruthy();
  const freshChildren = rebind?.params?.nodes ?? [];
  const invite = freshChildren.find((node) => hasId(node, "invite"));
  expect(
    invite,
    `fresh children carry A#invite: ${JSON.stringify(freshChildren).slice(0, 300)}`,
  ).toBeTruthy();
  expect(invite?.nodeName).toBe("A");
}

function hasId(node: any, id: string): boolean {
  const attrs: string[] = node?.attributes ?? [];
  const index = attrs.indexOf("id");
  return index >= 0 && attrs[index + 1] === id;
}

function pushChildren(stack: any[], node: any): void {
  for (const child of node?.children ?? []) stack.push(child);
}

function findById(node: any, id: string): any {
  const stack = [node];
  while (stack.length) {
    const candidate = stack.pop();
    if (!candidate) continue;
    if (hasId(candidate, id)) return candidate;
    pushChildren(stack, candidate);
  }
  return null;
}

test("dom-innerhtml-rebuild-demo", async ({ page, cdpSession: session }) => {
  const events: RebuildEvent[] = [];
  subscribeToRebuildEvents(session, events);

  const frameTree = await session.send("Page.getFrameTree");
  await session.send("Page.setDocumentContent", {
    frameId: frameTree.frameTree.frame.id,
    html: HTML,
  });
  await session.send("DOM.enable");
  const doc = await session.send("DOM.getDocument");
  const buttons = findById(doc.root, "buttons");
  expect(buttons, "#buttons bound in the initial tree").toBeTruthy();

  events.length = 0;
  await page.evaluate(() => {
    setTimeout(() => {
      document.getElementById("buttons")!.innerHTML =
        '<a id="invite" href="https://example.com/room/42">invite link</a>';
    }, 100);
  });
  await waitForButtonRebind(events, buttons.nodeId);
  assertRebuiltInvite(events, buttons.nodeId);
});
