// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("screencast-placeholder-demo", async ({ page }) => {
  console.log("[placeholder] target url before screencast:", page.url());

  const session = await page.target().createCDPSession();
  const t0 = Date.now();

  const frames = [];
  let resolveFirstFrame;
  const firstFrame = new Promise((r) => {
    resolveFirstFrame = r;
  });
  session.on("Page.screencastFrame", async (params) => {
    frames.push({
      sessionId: params.sessionId,
      bytes: params.data.length,
      t: Date.now() - t0,
    });
    resolveFirstFrame();
    console.log(
      `[placeholder] frame sid=${params.sessionId} bytes=${params.data.length} dt=${Date.now() - t0}ms`,
    );
    try {
      await session.send("Page.screencastFrameAck", {
        sessionId: params.sessionId,
      });
    } catch {}
  });

  await session.send("Page.startScreencast", {
    format: "jpeg",
    quality: 80,
    maxWidth: 800,
    maxHeight: 600,
  });
  console.log("[placeholder] startScreencast sent");

  let timer;
  await Promise.race([
    firstFrame,
    new Promise((r) => {
      timer = setTimeout(r, 2000);
    }),
  ]);
  clearTimeout(timer);
  expect(frames.length, "placeholder-within-2s").toBeGreaterThanOrEqual(1);

  expect(frames[0].t, "placeholder-arrives-quickly (<1000ms)").toBeLessThan(1000);

  await session.send("Page.stopScreencast");
  console.log(`[placeholder] stopped, total ${frames.length} frame(s)`);
});
