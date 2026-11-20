// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

interface FrameRow {
  ts: number;
  inCallback: number | null;
  afterAwait: number | null;
  custom: number | null;
  afterFrame: number | null;
}

// Each callback busy-waits so the clock moves on during the frame. The timelines must still read
// the frame's timestamp, as Web Animations' "update animations and send events" sets them.
test("document timelines read the animation frame's timestamp during the frame", async ({
  page,
}) => {
  await setContent(
    page,
    `<script>
  window.__rows = [];
  const custom = new DocumentTimeline({ originTime: 2 });
  (async () => {
    for (let i = 0; i < 8; i++) {
      const row = {};
      row.ts = await new Promise((resolve) =>
        requestAnimationFrame((ts) => {
          const start = Date.now();
          while (Date.now() - start < 3) {}
          row.inCallback = document.timeline.currentTime;
          resolve(ts);
        }),
      );
      row.afterAwait = document.timeline.currentTime;
      row.custom = custom.currentTime;
      await new Promise((resolve) => setTimeout(resolve, 0));
      row.afterFrame = document.timeline.currentTime;
      window.__rows.push(row);
    }
  })();
</script>`,
  );
  await page.waitForFunction("window.__rows.length === 8", { timeout: 20_000 });
  const rows = (await page.evaluate("window.__rows")) as FrameRow[];

  for (const row of rows) {
    const detail = JSON.stringify(row);
    // The WPT tolerance: the timeline subtracts an origin from an epoch-scale sum.
    expect(row.inCallback!, detail).toBeCloseTo(row.ts, 2);
    expect(row.afterAwait!, detail).toBeCloseTo(row.ts, 2);
    expect(row.custom!, detail).toBeCloseTo(row.ts - 2, 2);
    // Outside the frame the timeline follows the live clock again, which the busy wait moved on.
    expect(row.afterFrame!, detail).toBeGreaterThanOrEqual(row.ts + 3);
  }
});

// Frame time comes from the clock page-script captured at load, so a page clock patch cannot
// latch the timeline's high-water mark and freeze it.
test("a page that replaces performance.now does not freeze document.timeline", async ({ page }) => {
  await setContent(
    page,
    `<script>
  window.__times = [];
  performance.now = () => 1e15;
  (async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => setTimeout(resolve, 5));
      window.__times.push(document.timeline.currentTime);
    }
  })();
</script>`,
  );
  await page.waitForFunction("window.__times.length === 4", { timeout: 20_000 });
  const times = (await page.evaluate("window.__times")) as number[];
  const detail = JSON.stringify(times);
  for (let i = 1; i < times.length; i++) {
    expect(times[i]!, detail).toBeGreaterThan(times[i - 1]!);
  }
  expect(times[times.length - 1]!, detail).toBeLessThan(1e14);
});

// The timeline reads the wall clock dom-shim captured at load, so a page that moves Date.now
// ahead and back does not latch it ahead and finish every running animation.
test("a page that moves Date.now ahead and back does not latch document.timeline", async ({
  page,
}) => {
  await setContent(
    page,
    `<div id=box>box</div>
<script>
  window.__state = (async () => {
    const animation = document.getElementById("box").animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 1000000 },
    );
    const before = document.timeline.currentTime;
    const realNow = Date.now;
    Date.now = () => realNow.call(Date) + 3600000;
    document.timeline.currentTime;
    Date.now = realNow;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { before, after: document.timeline.currentTime, playState: animation.playState };
  })();
</script>`,
  );
  const state = (await page.evaluate("window.__state")) as {
    before: number;
    after: number;
    playState: string;
  };
  const detail = JSON.stringify(state);
  expect(state.playState, detail).toBe("running");
  expect(state.after - state.before, detail).toBeLessThan(60000);
});
