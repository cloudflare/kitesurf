// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

function nodeHasId(node, id): boolean {
  const attrs = node.attributes || [];
  const index = attrs.indexOf("id");
  return index >= 0 && attrs[index + 1] === id;
}

function pushChildren(stack, node): void {
  if (Array.isArray(node.children)) {
    for (const child of node.children) stack.push(child);
  }
}

function findById(root, id) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (nodeHasId(node, id)) return node;
    pushChildren(stack, node);
  }
  return null;
}

function findDirectChildById(parent, id) {
  if (!parent || !Array.isArray(parent.children)) return null;
  return parent.children.find((child) => nodeHasId(child, id)) ?? null;
}

function assertDocumentNodes(rootEl, helloEl): void {
  expect(rootEl !== null, "#root located in tree").toBeTruthy();
  expect(helloEl !== null, "#hello located").toBeTruthy();
}

function assertModifiedAttribute(event, expectedValue: string, details: string): void {
  expect(
    event !== undefined &&
      event.params.value === expectedValue &&
      typeof event.params.nodeId === "number",
    details,
  ).toBeTruthy();
}

function assertCharacterData(event, details: string): void {
  expect(event !== undefined && event.params.characterData === "world", details).toBeTruthy();
}

function assertInsertedNode(inserted, events): void {
  expect(
    inserted !== undefined,
    "childNodeInserted fired: " + JSON.stringify(events.slice(0, 3)),
  ).toBeTruthy();
  if (!inserted) return;
  assertInsertedNodeName(inserted);
  assertInsertedNodeId(inserted);
  assertInsertedNodeText(inserted);
}

function assertInsertedNodeName(inserted): void {
  const name = inserted.params?.node?.nodeName;
  expect(name === "SPAN", `inserted.node has nodeName SPAN: got nodeName ${name}`).toBeTruthy();
}

function assertInsertedNodeId(inserted): void {
  const attrs = inserted.params?.node?.attributes || [];
  const idIndex = attrs.indexOf("id");
  expect(
    idIndex >= 0 && attrs[idIndex + 1] === "appended",
    "inserted.node.attributes contains id=appended: " + JSON.stringify(attrs),
  ).toBeTruthy();
}

function assertInsertedNodeText(inserted): void {
  const children = insertedNodeChildren(inserted);
  const firstChildValue = children[0]?.nodeValue;
  expect(
    children.length === 1 && firstChildValue === "buy milk",
    "inserted.node.children includes the text node: " + JSON.stringify(children),
  ).toBeTruthy();
}

function insertedNodeChildren(inserted) {
  return inserted.params?.node?.children || [];
}

function assertOrderedInserts(inserts): void {
  expect(
    inserts.length === 3,
    `three childNodeInserted events for three appendChilds: got ${inserts.length}: ${JSON.stringify(inserts.map((e) => e.params?.node?.nodeName))}`,
  ).toBeTruthy();
  if (inserts.length !== 3) return;
  assertSecondInsertFollowsFirst(inserts);
  assertThirdInsertFollowsSecond(inserts);
}

function assertSecondInsertFollowsFirst(inserts): void {
  const previousNodeId = inserts[1].params?.previousNodeId;
  const firstNodeId = inserts[0].params?.node?.nodeId;
  expect(
    previousNodeId === firstNodeId,
    `second insert.previousNodeId === first insert.nodeId: prev=${previousNodeId}, want=${firstNodeId}`,
  ).toBeTruthy();
}

function assertThirdInsertFollowsSecond(inserts): void {
  const previousNodeId = inserts[2].params?.previousNodeId;
  const secondNodeId = inserts[1].params?.node?.nodeId;
  expect(
    previousNodeId === secondNodeId,
    `third insert.previousNodeId === second insert.nodeId: prev=${previousNodeId}, want=${secondNodeId}`,
  ).toBeTruthy();
}

function hasNumericRootNodeId(doc: { root?: { nodeId?: number } } | null | undefined): boolean {
  return typeof doc?.root?.nodeId === "number";
}

function formatDiagnosticEvent(event: unknown): string {
  return String(JSON.stringify(event || null));
}

test("dom-mutation-events-demo", async ({ page }) => {
  const HTML = `<!doctype html>
<html>
<head><title>mutation-events-probe</title></head>
<body>
  <div id="root">
    <p id="hello">hello</p>
  </div>
  <script>
    // Idle script — we drive mutations via page.evaluate so the
    // demo can sequence them around DOM.getDocument.
    window.__ready = true;
  </script>
</body>
</html>`;

  const session = await page.target().createCDPSession();
  const events = [];
  const wantedMethods = new Set([
    "DOM.childNodeInserted",
    "DOM.childNodeRemoved",
    "DOM.childNodeCountUpdated",
    "DOM.attributeModified",
    "DOM.attributeRemoved",
    "DOM.characterDataModified",
    "DOM.setChildNodes",
  ]);
  for (const m of wantedMethods) {
    session.on(m, (params) => events.push({ method: m, params }));
  }

  const frameTree = await session.send("Page.getFrameTree");
  await session.send("Page.setDocumentContent", {
    frameId: frameTree.frameTree.frame.id,
    html: HTML,
  });
  const eventsBeforeObserve = events.length;
  expect(
    eventsBeforeObserve === 0,
    `no DOM events before DOM.getDocument (gate closed): got ${eventsBeforeObserve} events: ${JSON.stringify(events.slice(0, 3))}`,
  ).toBeTruthy();

  await page.evaluate(() => {
    document.getElementById("hello").setAttribute("data-stage", "pre-observe");
  });
  expect(
    events.length === eventsBeforeObserve,
    `no events for pre-observe mutation: gained ${events.length - eventsBeforeObserve} events`,
  ).toBeTruthy();

  await session.send("DOM.enable");
  const doc = await session.send("DOM.getDocument");
  expect(
    hasNumericRootNodeId(doc),
    "DOM.getDocument returned a root node: no root in response",
  ).toBeTruthy();
  const rootEl = findById(doc.root, "root");
  const helloEl = findDirectChildById(rootEl, "hello");
  assertDocumentNodes(rootEl, helloEl);

  events.length = 0;

  await page.evaluate(() => {
    document.getElementById("hello").setAttribute("data-tag", "first-attr");
  });
  await expect
    .poll(
      () =>
        events.some((e) => e.method === "DOM.attributeModified" && e.params?.name === "data-tag"),
      { timeout: 10_000 },
    )
    .toBe(true);
  const attrModified = events.find(
    (e) => e.method === "DOM.attributeModified" && e.params?.name === "data-tag",
  );
  assertModifiedAttribute(
    attrModified,
    "first-attr",
    "attributeModified fired with name+value: " + formatDiagnosticEvent(attrModified),
  );

  events.length = 0;
  await page.evaluate(() => {
    document.getElementById("hello").removeAttribute("data-tag");
  });
  await expect
    .poll(
      () =>
        events.some((e) => e.method === "DOM.attributeRemoved" && e.params?.name === "data-tag"),
      { timeout: 10_000 },
    )
    .toBe(true);
  const attrRemoved = events.find(
    (e) => e.method === "DOM.attributeRemoved" && e.params?.name === "data-tag",
  );
  expect(
    attrRemoved !== undefined,
    "attributeRemoved fired with name: " + JSON.stringify(events),
  ).toBeTruthy();

  events.length = 0;
  await page.evaluate(() => {
    (document.getElementById("hello").firstChild as Text).data = "world";
  });
  await expect
    .poll(() => events.some((e) => e.method === "DOM.characterDataModified"), { timeout: 10_000 })
    .toBe(true);
  const charData = events.find((e) => e.method === "DOM.characterDataModified");
  assertCharacterData(
    charData,
    "characterDataModified fired with new value: " + formatDiagnosticEvent(charData),
  );

  events.length = 0;
  await page.evaluate(() => {
    const span = document.createElement("span");
    span.id = "appended";
    span.className = "boxy";
    span.textContent = "buy milk";
    document.getElementById("root").appendChild(span);
  });
  await expect
    .poll(() => events.some((e) => e.method === "DOM.childNodeInserted"), {
      timeout: 10_000,
    })
    .toBe(true);
  const inserted = events.find((e) => e.method === "DOM.childNodeInserted");
  assertInsertedNode(inserted, events);

  events.length = 0;
  await page.evaluate(() => {
    const el = document.getElementById("appended");
    el.parentNode.removeChild(el);
  });
  await expect
    .poll(() => events.some((e) => e.method === "DOM.childNodeRemoved"), {
      timeout: 10_000,
    })
    .toBe(true);
  const removed = events.find((e) => e.method === "DOM.childNodeRemoved");
  expect(removed !== undefined, "childNodeRemoved fired: " + JSON.stringify(events)).toBeTruthy();

  events.length = 0;
  await page.evaluate(() => {
    const root = document.getElementById("root");
    const a = document.createElement("li");
    a.textContent = "buy";
    const b = document.createElement("li");
    b.textContent = "ship";
    const c = document.createElement("li");
    c.textContent = "win";
    root.appendChild(a);
    root.appendChild(b);
    root.appendChild(c);
  });
  await expect
    .poll(() => events.filter((e) => e.method === "DOM.childNodeInserted").length, {
      timeout: 10_000,
    })
    .toBe(3);
  await page.evaluate(() => {
    document.getElementById("root").setAttribute("data-batch-barrier", "1");
  });
  await expect
    .poll(
      () =>
        events.some(
          (e) => e.method === "DOM.attributeModified" && e.params?.name === "data-batch-barrier",
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  const inserts = events.filter((e) => e.method === "DOM.childNodeInserted");
  assertOrderedInserts(inserts);

  events.length = 0;
  await page.evaluate(() => {
    const inp = document.createElement("input");
    inp.id = "todo-in";
    inp.type = "text";
    document.getElementById("root").appendChild(inp);
  });
  await expect
    .poll(
      () =>
        events.some(
          (e) => e.method === "DOM.childNodeInserted" && e.params?.node?.nodeName === "INPUT",
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
  events.length = 0;
  await page.evaluate(() => document.getElementById("todo-in").focus());
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    text: "b",
    key: "b",
    code: "KeyB",
    windowsVirtualKeyCode: 66,
  });
  const idlValue = await page.evaluate(
    () => (document.getElementById("todo-in") as HTMLInputElement).value,
  );
  expect(idlValue, "input IDL value after keydown 'b'").toBe("b");
  const spuriousValueAttr = events.find(
    (e) => e.method === "DOM.attributeModified" && e.params?.name === "value",
  );
  expect(
    spuriousValueAttr === undefined,
    "no spurious attributeModified(value) — attribute reflects defaultValue: " +
      JSON.stringify(events.slice(0, 5)),
  ).toBeTruthy();
});
