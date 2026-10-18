// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("mouse-move-debounce-probe", async ({ page }) => {
  const cdp = await page.target().createCDPSession();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  const consoleLines = [];
  cdp.on("Runtime.consoleAPICalled", (e) => {
    const parts = (e.args ?? []).map((a) => {
      if (a.type === "string") return a.value;
      if (a.value !== undefined) return String(a.value);
      return a.description ?? `<${a.type}>`;
    });
    consoleLines.push({ type: e.type, text: parts.join(" ") });
  });

  const html = `<!doctype html><html><head><title>debounce probe</title></head>
<body>
<div id="target" style="width:400px;height:400px;background:#eef">target</div>
<script>
window.__moveCount = 0;
window.__clickCount = 0;
window.__lastMoveAt = 0;
window.__order = [];
document.addEventListener("mousemove", function(e) {
  window.__moveCount++;
  window.__lastMoveAt = Date.now();
  window.__order.push("move:" + e.clientX + "," + e.clientY);
});
document.addEventListener("click", function(e) {
  window.__clickCount++;
  window.__order.push("click:" + e.clientX + "," + e.clientY);
});
console.log("[probe] handlers attached");
</script>
</body></html>`;

  await cdp.send("Page.navigate", {
    url: "data:text/html;charset=utf-8," + encodeURIComponent(html),
  });
  await new Promise((r) => {
    cdp.once("Page.loadEventFired", r);
    setTimeout(r, 5000);
  });
  await new Promise((r) => setTimeout(r, 200));

  const burstSize = 60;
  const burstStart = Date.now();
  for (let i = 0; i < burstSize; i++) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 100 + i,
      y: 100,
    });
  }
  const burstEnd = Date.now();
  console.log(`[probe] sent ${burstSize} moves in ${burstEnd - burstStart} ms`);

  await new Promise((r) => setTimeout(r, 100));

  const moveCountResult = await cdp.send("Runtime.evaluate", {
    expression: "JSON.stringify({ moves: window.__moveCount, order: window.__order })",
    returnByValue: true,
  });
  const stats1 = JSON.parse(moveCountResult.result.value);
  console.log(`[probe] page saw ${stats1.moves} mousemove events (sent ${burstSize})`);
  console.log(`[probe] last position dispatched: ${stats1.order[stats1.order.length - 1]}`);

  expect(
    stats1.moves,
    `debounce ineffective: ${stats1.moves} of ${burstSize} dispatched`,
  ).toBeLessThan(burstSize / 2);
  expect(stats1.moves, "at least one move should dispatch").toBeGreaterThanOrEqual(1);
  const lastEntry = stats1.order[stats1.order.length - 1];
  expect(lastEntry, "latest position should win").toBe("move:159,100");

  await cdp.send("Runtime.evaluate", {
    expression: "window.__order.length = 0; window.__moveCount = 0; window.__clickCount = 0;",
    returnByValue: true,
  });

  for (let i = 0; i < 5; i++) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 200 + i,
      y: 200,
    });
  }
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: 204,
    y: 200,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: 204,
    y: 200,
    button: "left",
    clickCount: 1,
  });
  await new Promise((r) => setTimeout(r, 100));

  const orderResult = await cdp.send("Runtime.evaluate", {
    expression: "JSON.stringify(window.__order)",
    returnByValue: true,
  });
  const order = JSON.parse(orderResult.result.value);
  console.log("[probe] event order:", order);

  const firstMoveIdx = order.findIndex((e) => e.startsWith("move:"));
  const firstClickIdx = order.findIndex((e) => e.startsWith("click:"));
  expect(firstMoveIdx, "at least one move dispatched").toBeGreaterThanOrEqual(0);
  expect(firstClickIdx, "click dispatched").toBeGreaterThanOrEqual(0);
  expect(
    firstMoveIdx < firstClickIdx,
    `mousemove should precede click, got order: ${order.join(" ")}`,
  ).toBeTruthy();
  const moveBeforeClick = order
    .slice(0, firstClickIdx)
    .reverse()
    .find((e) => e.startsWith("move:"));
  expect(moveBeforeClick, "move just before click should be latest pending (204,200)").toBe(
    "move:204,200",
  );
});
