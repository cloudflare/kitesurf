// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("an overrunning rAF frame waits a full frame before the next", async ({
  page,
  cdpSession,
}) => {
  await setContent(
    page,
    `<canvas id="c" width="200" height="100"></canvas>
<script>
  window.__gaps = [];
  let lastEnd = 0;
  const ctx = document.getElementById("c").getContext("2d");
  function frame() {
    const start = Date.now();
    if (lastEnd) window.__gaps.push(start - lastEnd);
    while (Date.now() - start < 30) {}
    ctx.fillStyle = window.__gaps.length % 2 ? "#f00" : "#00f";
    ctx.fillRect(0, 0, 200, 100);
    lastEnd = Date.now();
    if (window.__gaps.length < 30) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
</script>`,
  );

  let frames = 0;
  cdpSession.on("Page.screencastFrame", (ev: { sessionId: number }) => {
    frames++;
    cdpSession.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });
  await cdpSession.send("Page.startScreencast", { format: "jpeg", everyNthFrame: 1 });
  await page.waitForFunction("window.__gaps.length >= 30", { timeout: 20_000 });
  await cdpSession.send("Page.stopScreencast");

  const gaps = await page.evaluate(() => (window as typeof window & { __gaps: number[] }).__gaps);
  expect(frames, "the screencast delivered frames").toBeGreaterThan(0);
  expect(Math.min(...gaps), `gaps between frames: ${gaps.join(",")}`).toBeGreaterThanOrEqual(15);
});
