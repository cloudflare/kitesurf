// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Protocol } from "devtools-protocol";

import { expect, test } from "../harness";

test("mouse-events-demo", async ({ page }) => {
  const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>mouse</title>
<style>
  body { margin: 0; padding: 24px; font-family: sans-serif; background: #fff; }
  h1 { color: #c0392b; margin: 0 0 12px 0; font-size: 28px; }
  button { display: block; padding: 12px 24px; margin: 16px 0;
           background: #4a90e2; color: white; border: 0; font-size: 18px; }
  #target { background: #50c878; }
</style></head>
<body>
  <h1 id="hdr">mouse target page</h1>
  <button id="btn1">first button</button>
  <button id="target">click me</button>
  <button id="btn3">third button</button>
  <p id="status">unclicked</p>
  <script>
    document.querySelector("#target").addEventListener("click", (e) => {
      document.querySelector("#status").textContent =
        "clicked at (" + e.clientX + "," + e.clientY + ")";
    });
  </script>
</body></html>`;

  await page.goto(`data:text/html,${encodeURIComponent(PAGE_HTML)}`, {
    timeout: 15000,
  });

  const rects = await page.evaluate(() => {
    const ids = ["hdr", "btn1", "target", "btn3", "status"];
    const out: Record<string, { x: number; y: number; width: number; height: number }> = {};
    for (const id of ids) {
      const r = document.querySelector("#" + id).getBoundingClientRect();
      out[id] = { x: r.x, y: r.y, width: r.width, height: r.height };
    }
    return out;
  });
  console.log("[mouse] rects:", JSON.stringify(rects, null, 2));

  for (const [id, r] of Object.entries(rects)) {
    expect(r.width > 0 && r.height > 0, `${id}-has-nonzero-size`).toBeTruthy();
  }
  expect(
    rects.hdr.y !== rects.btn1.y &&
      rects.btn1.y !== rects.target.y &&
      rects.target.y !== rects.btn3.y,
    "rects-are-distinct",
  ).toBeTruthy();
  expect(
    rects.hdr.x === rects.btn1.x && rects.btn1.x === rects.target.x,
    "non-synthetic-x (block layout shares x)",
  ).toBeTruthy();

  const fromPoint = await page.evaluate((tr) => {
    const cx = tr.x + tr.width / 2;
    const cy = tr.y + tr.height / 2;
    const el = document.elementFromPoint(cx, cy);
    return { id: el ? el.id : null, tag: el ? el.tagName : null };
  }, rects.target);
  console.log("[mouse] elementFromPoint(target center):", fromPoint);
  expect(fromPoint.id, "elementFromPoint-returns-target").toBe("target");

  const session = await page.target().createCDPSession();
  const cx = rects.target.x + rects.target.width / 2;
  const cy = rects.target.y + rects.target.height / 2;
  await session.send("Input.dispatchMouseEvent", {
    // oxlint-disable-next-line kitesurf/no-chained-type-assertions -- input.ts maps click.
    type: "click" as unknown as Protocol.Input.DispatchMouseEventRequest["type"],
    x: cx,
    y: cy,
    button: "left",
    clickCount: 1,
  });
  await page
    .waitForFunction(
      `(document.querySelector("#status").textContent || "").startsWith("clicked at (")`,
      { timeout: 10000 },
    )
    .catch(() => {});

  const status = await page.evaluate(() => document.querySelector("#status").textContent);
  console.log("[mouse] status after click:", status);
  expect(status.startsWith("clicked at ("), "click-routed-to-target").toBeTruthy();

  const doc = await session.send("DOM.getDocument");
  const root = doc.root.nodeId;
  const targetNode = await session.send("DOM.querySelector", {
    nodeId: root,
    selector: "#target",
  });
  console.log("[mouse] querySelector('#target') nodeId =", targetNode.nodeId);
  expect(targetNode.nodeId, "querySelector-found-target").toBeGreaterThan(0);

  const boxModel = await session.send("DOM.getBoxModel", {
    nodeId: targetNode.nodeId,
  });
  console.log("[mouse] DOM.getBoxModel:", JSON.stringify(boxModel));
  expect(
    boxModel.model && Array.isArray(boxModel.model.content),
    "getBoxModel-has-content",
  ).toBeTruthy();
  const c = boxModel.model.content;
  const bx = (c[0] + c[4]) / 2;
  const by = (c[1] + c[5]) / 2;
  expect(Math.abs(bx - cx), "boxModel-matches-rect-x").toBeLessThan(1);
  expect(Math.abs(by - cy), "boxModel-matches-rect-y").toBeLessThan(1);

  const fromLoc = await session.send("DOM.getNodeForLocation", {
    x: cx,
    y: cy,
  });
  console.log("[mouse] getNodeForLocation:", fromLoc);
  expect(fromLoc.nodeId, "getNodeForLocation-finds-target").toBeGreaterThan(0);
});
