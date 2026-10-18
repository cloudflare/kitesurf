// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

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
    typeof doc?.root?.nodeId === "number",
    "DOM.getDocument returned a root node: no root in response",
  ).toBeTruthy();
  const rootEl = (() => {
    const stack = [doc.root];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      const idAttr = (n.attributes || []).indexOf("id");
      if (idAttr >= 0 && (n.attributes || [])[idAttr + 1] === "root") return n;
      if (Array.isArray(n.children)) for (const c of n.children) stack.push(c);
    }
    return null;
  })();
  expect(rootEl !== null, "#root located in tree").toBeTruthy();
  const helloEl = (() => {
    if (!rootEl || !Array.isArray(rootEl.children)) return null;
    for (const c of rootEl.children) {
      const idx = (c.attributes || []).indexOf("id");
      if (idx >= 0 && (c.attributes || [])[idx + 1] === "hello") return c;
    }
    return null;
  })();
  expect(helloEl !== null, "#hello located").toBeTruthy();

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
  expect(
    attrModified !== undefined &&
      attrModified.params.value === "first-attr" &&
      typeof attrModified.params.nodeId === "number",
    "attributeModified fired with name+value: " + JSON.stringify(attrModified || null),
  ).toBeTruthy();

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
  expect(
    charData !== undefined && charData.params.characterData === "world",
    "characterDataModified fired with new value: " + JSON.stringify(charData || null),
  ).toBeTruthy();

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
  expect(
    inserted !== undefined,
    "childNodeInserted fired: " + JSON.stringify(events.slice(0, 3)),
  ).toBeTruthy();
  if (inserted) {
    expect(
      inserted.params?.node?.nodeName === "SPAN",
      `inserted.node has nodeName SPAN: got nodeName ${inserted.params?.node?.nodeName}`,
    ).toBeTruthy();
    const attrs = inserted.params?.node?.attributes || [];
    const idIdx = attrs.indexOf("id");
    expect(
      idIdx >= 0 && attrs[idIdx + 1] === "appended",
      "inserted.node.attributes contains id=appended: " + JSON.stringify(attrs),
    ).toBeTruthy();
    const kids = inserted.params?.node?.children || [];
    expect(
      kids.length === 1 && kids[0]?.nodeValue === "buy milk",
      "inserted.node.children includes the text node: " + JSON.stringify(kids),
    ).toBeTruthy();
  }

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
  expect(
    inserts.length === 3,
    `three childNodeInserted events for three appendChilds: got ${inserts.length}: ${JSON.stringify(inserts.map((e) => e.params?.node?.nodeName))}`,
  ).toBeTruthy();
  if (inserts.length === 3) {
    const id0 = inserts[0].params?.node?.nodeId;
    const id1 = inserts[1].params?.node?.nodeId;
    expect(
      inserts[1].params?.previousNodeId === id0,
      `second insert.previousNodeId === first insert.nodeId: prev=${inserts[1].params?.previousNodeId}, want=${id0}`,
    ).toBeTruthy();
    expect(
      inserts[2].params?.previousNodeId === id1,
      `third insert.previousNodeId === second insert.nodeId: prev=${inserts[2].params?.previousNodeId}, want=${id1}`,
    ).toBeTruthy();
  }

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
