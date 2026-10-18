// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import type { CDPSession } from "@cloudflare/puppeteer";

declare global {
  interface Window {
    rafs: number;
    rearmed: Promise<void>;
  }
}

function rafPage(nextFrame: string): string {
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html>
<html><body><div id="n">0</div><script>
  window.rafs = 0;
  const n = document.getElementById("n");
  (function step() {
    window.rafs++;
    n.textContent = String(window.rafs);
    ${nextFrame}
  })();
</script></body></html>`)
  );
}

const RAF_PAGE = rafPage("requestAnimationFrame(step);");

const FRAME_INTERVAL_MS = 100;
const MEASURED_FRAMES = 10;
const MAX_RAFS_PER_FRAME = 1.5;
const MIN_RAFS_PER_FRAME_FRACTION = 0.75;
const FALLBACK_RAFS = 30;
const FALLBACK_MAX_MS = 2_000;

function countFrames(session: CDPSession) {
  let frames = 0;
  const acks: Promise<unknown>[] = [];
  session.on("Page.screencastFrame", (ev: { sessionId: number }) => {
    frames++;
    acks.push(session.send("Page.screencastFrameAck", { sessionId: ev.sessionId }));
  });
  return { count: () => frames, acks };
}

test.for([
  {
    name: "timer",
    nextFrame: "setTimeout(() => requestAnimationFrame(step), 90);",
    frameIntervalMs: FRAME_INTERVAL_MS,
    measuredFrames: 20,
  },
  {
    name: "promise",
    nextFrame: "Promise.resolve().then(() => requestAnimationFrame(step));",
    frameIntervalMs: 16,
    measuredFrames: 60,
  },
])(
  "$name-rearmed rAF keeps up with the screencast",
  async ({ nextFrame, frameIntervalMs, measuredFrames }, { page, cdpSession }) => {
    await page.goto(rafPage(nextFrame), { timeout: 25_000 });
    const rafs = () => page.evaluate(() => window.rafs);
    const frames = countFrames(cdpSession);
    const screencast = {
      format: "jpeg" as const,
      quality: 50,
      minFrameIntervalMs: frameIntervalMs,
    };
    await cdpSession.send("Page.startScreencast", screencast);
    try {
      await expect.poll(frames.count, { timeout: 15_000 }).toBeGreaterThan(2);
      const frames0 = frames.count();
      const rafs0 = await rafs();
      await expect
        .poll(frames.count, { timeout: 15_000, interval: 25 })
        .toBeGreaterThanOrEqual(frames0 + measuredFrames);
      const frameCount = frames.count() - frames0;
      const rafCount = (await rafs()) - rafs0;
      expect(rafCount).toBeGreaterThanOrEqual(Math.floor(frameCount * MIN_RAFS_PER_FRAME_FRACTION));
      expect(rafCount).toBeLessThanOrEqual(Math.ceil(frameCount * MAX_RAFS_PER_FRAME) + 2);
    } finally {
      await cdpSession.send("Page.stopScreencast");
      await Promise.all(frames.acks);
    }
  },
);

test("rAF follows the screencast frame rate and falls back when it stops", async ({
  page,
  cdpSession,
}) => {
  await page.goto(RAF_PAGE, { timeout: 25_000 });
  const rafs = () => page.evaluate(() => window.rafs);

  const frames = countFrames(cdpSession);
  const screencast = {
    format: "jpeg" as const,
    quality: 50,
    minFrameIntervalMs: FRAME_INTERVAL_MS,
  };
  await cdpSession.send("Page.startScreencast", screencast);
  await expect.poll(frames.count, { timeout: 15_000 }).toBeGreaterThan(2);

  const frames0 = frames.count();
  const rafs0 = await rafs();
  await expect
    .poll(frames.count, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(frames0 + MEASURED_FRAMES);
  const frameCount = frames.count() - frames0;
  const rafCount = (await rafs()) - rafs0;
  expect(
    rafCount,
    `${rafCount} rAF frames for ${frameCount} screencast frames`,
  ).toBeLessThanOrEqual(Math.ceil(frameCount * MAX_RAFS_PER_FRAME) + 2);

  await cdpSession.send("Page.stopScreencast");
  await Promise.all(frames.acks);
  const stopped = Date.now();
  const rafs1 = await rafs();
  await expect
    .poll(rafs, { timeout: 15_000, interval: 50 })
    .toBeGreaterThanOrEqual(rafs1 + FALLBACK_RAFS);
  expect(Date.now() - stopped, "rAF back on the backstop").toBeLessThan(FALLBACK_MAX_MS);
});

test("a driver tick runs a rAF a timer queued just before it", async ({ page, cdpSession }) => {
  const frameIntervalMs = 100;
  const rearmDelayMs = 30;
  const ticks = 5;
  await page.setViewport({ width: 64, height: 64 });
  await page.goto("data:text/html,<body>ready</body>");
  await page.evaluate((rearmDelayMs) => {
    window.rafs = 0;
    const step = () => {
      window.rafs++;
      window.rearmed = new Promise<void>((resolve) => {
        setTimeout(() => {
          requestAnimationFrame(step);
          resolve();
        }, rearmDelayMs);
      });
    };
    requestAnimationFrame(step);
  }, rearmDelayMs);
  const driverTick = () =>
    cdpSession.send("Kitesurf.recordScene", {
      pumpRaf: true,
      frameIntervalMs,
    });
  await expect.poll(() => page.evaluate(() => window.rafs)).toBeGreaterThan(0);
  await driverTick();
  const ranOnTick: boolean[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    const before = await page.evaluate(async () => {
      await window.rearmed;
      return window.rafs;
    });
    await driverTick();
    ranOnTick.push((await page.evaluate(() => window.rafs)) === before + 1);
  }
  expect(ranOnTick).toEqual(Array(ticks).fill(true));
});

test("a timer can register the next rAF after the driver stops", async ({ page, cdpSession }) => {
  const frameIntervalMs = 1_000;
  const driverGraceIntervals = 2;
  const fallbackSlackMs = 500;
  const fallbackTimeoutMs = frameIntervalMs * driverGraceIntervals + fallbackSlackMs;
  await page.setViewport({ width: 64, height: 64 });
  await page.goto("data:text/html,<body>ready</body>");
  const frames = countFrames(cdpSession);
  const screencast = { format: "jpeg" as const, minFrameIntervalMs: frameIntervalMs };
  await cdpSession.send("Page.startScreencast", screencast);
  await expect.poll(frames.count).toBeGreaterThan(0);
  await cdpSession.send("Page.stopScreencast");
  await Promise.all(frames.acks);

  const result = await page.evaluate(
    (fallbackTimeoutMs) =>
      new Promise<string>((resolve) => {
        const timeout = setTimeout(() => resolve("missed frame"), fallbackTimeoutMs);
        setTimeout(
          () =>
            requestAnimationFrame(() => {
              clearTimeout(timeout);
              resolve("ran");
            }),
          0,
        );
      }),
    fallbackTimeoutMs,
  );
  expect(result).toBe("ran");
});

test("a faster screencast releases the previous rAF deadline", async ({ page, cdpSession }) => {
  const slowFrameIntervalMs = 1_000;
  const fastFrameIntervalMs = 16;
  const maxResumeMs = 500;
  await page.setViewport({ width: 64, height: 64 });
  await page.goto(RAF_PAGE);
  const frames = countFrames(cdpSession);
  const slow = { format: "jpeg" as const, minFrameIntervalMs: slowFrameIntervalMs };
  await cdpSession.send("Page.startScreencast", slow);
  await expect.poll(frames.count).toBeGreaterThan(0);
  await cdpSession.send("Page.stopScreencast");
  await Promise.all(frames.acks);
  const before = await page.evaluate(() => window.rafs);
  const fast = { format: "jpeg" as const, minFrameIntervalMs: fastFrameIntervalMs };
  const started = Date.now();
  await cdpSession.send("Page.startScreencast", fast);
  await expect
    .poll(() => page.evaluate(() => window.rafs), { timeout: maxResumeMs })
    .toBeGreaterThanOrEqual(before + 5);
  expect(Date.now() - started).toBeLessThan(maxResumeMs);
  await cdpSession.send("Page.stopScreencast");
  await Promise.all(frames.acks);
});
