// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("page-renderer-screencast", async ({ page, cdpSession }) => {
  const boxes = Array.from({ length: 300 })
    .map(
      (_, i) => `<div class="b" style="background:hsl(${(i * 13) % 360},70%,60%)">box ${i}</div>`,
    )
    .join("");
  const HTML_URL =
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html>
<html><head><style>
  body { margin: 0; padding: 10px; font-family: sans-serif; background: linear-gradient(#fff, #eef); }
  .grid { display: flex; flex-wrap: wrap; gap: 4px; }
  .b { width: 60px; height: 30px; font-size: 9px; color: #fff; border-radius: 4px;
       box-shadow: 1px 1px 2px rgba(0,0,0,0.3); }
  #ticker { font-size: 20px; color: #113; }
</style></head>
<body>
  <h2 id="ticker">tick 0</h2>
  <div class="grid">${boxes}</div>
</body></html>`);

  await page.goto(HTML_URL, { timeout: 25000 });

  const frames: Array<{ at: number; bytes: number }> = [];
  let ackFailures = 0;
  let frameWaiters: Array<{ need: number; resolve: () => void }> = [];
  cdpSession.on("Page.screencastFrame", (ev: { data: string; sessionId: number }) => {
    frames.push({ at: Date.now(), bytes: ev.data.length });
    frameWaiters = frameWaiters.filter((w) => {
      if (frames.length < w.need) return true;
      w.resolve();
      return false;
    });
    cdpSession.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {
      ackFailures += 1;
    });
  });

  await cdpSession.send("Page.startScreencast", {
    format: "jpeg",
    quality: 80,
    everyNthFrame: 1,
  });

  const waitFor = async (n: number, timeoutMs: number) => {
    if (frames.length >= n) return true;
    const reached = new Promise<void>((resolve) => {
      frameWaiters.push({ need: n, resolve });
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([reached, timedOut]);
    clearTimeout(timer);
    return frames.length >= n;
  };
  expect(await waitFor(1, 10_000), "first frame arrives").toBe(true);

  for (let i = 1; i <= 5; i++) {
    const before = frames.length;
    await page.evaluate((n: number) => {
      const el = document.getElementById("ticker");
      if (el) el.textContent = `tick ${n}`;
    }, i);
    expect(await waitFor(before + 1, 10_000), `frame after mutation ${i} (had ${before})`).toBe(
      true,
    );
  }

  await cdpSession.send("Page.stopScreencast");

  const info = await cdpSession.send("Kitesurf.getRendererInfo");
  console.log(
    `[screencast] frames=${frames.length} rendererFrames=${info.framesRendered} ` +
      `relaunches=${info.relaunchCount} ackFailures=${ackFailures}`,
  );
  expect(info.enabled, "scene path enabled").toBe(true);
  expect(info.framesRendered, "frames came from the renderer").toBeGreaterThanOrEqual(
    frames.length,
  );
  expect(frames.length, "at least initial + 5 mutation frames").toBeGreaterThanOrEqual(6);
  expect(ackFailures, "all acks delivered").toBe(0);
  for (const [i, f] of frames.entries()) {
    expect(f.bytes, `frame ${i} non-trivial`).toBeGreaterThan(1000);
  }
});
