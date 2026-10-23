// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { decodePng } from "./png";

const FIXTURE = "https://ks.invalid/__fixtures/screencast-partial-image.html";

function b64Bytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function pixelAt(
  png: Awaited<ReturnType<typeof decodePng>>,
  xAt200: number,
  yAt200: number,
): [number, number, number] {
  const x = Math.round((xAt200 * png.width) / 200);
  const y = Math.round((yAt200 * png.height) / 200);
  const i = (y * png.width + x) * 4;
  return [png.data[i] ?? 0, png.data[i + 1] ?? 0, png.data[i + 2] ?? 0];
}

const isRed = ([r, g, b]: [number, number, number]): boolean => r > 200 && g < 80 && b < 80;
const isWhite = ([r, g, b]: [number, number, number]): boolean => r > 200 && g > 200 && b > 200;

async function waitForNewFrame(
  frameCount: number,
  decodedThrough: number,
  deadline: number,
  waitForFrames: (count: number, budgetMs: number) => Promise<boolean>,
): Promise<boolean> {
  if (frameCount > decodedThrough) return true;
  return waitForFrames(decodedThrough + 1, deadline - Date.now());
}

async function frameIsRed(frame: { data: string } | undefined): Promise<boolean> {
  if (!frame) return false;
  const png = await decodePng(b64Bytes(frame.data));
  return isRed(pixelAt(png, 100, 100));
}

async function waitForRedFrame(
  frames: Array<{ at: number; data: string }>,
  waitForFrames: (count: number, budgetMs: number) => Promise<boolean>,
  deadline: number,
): Promise<boolean> {
  let decodedThrough = 0;
  while (Date.now() < deadline) {
    if (!(await waitForNewFrame(frames.length, decodedThrough, deadline, waitForFrames))) break;
    decodedThrough = frames.length;
    if (await frameIsRed(frames[frames.length - 1])) return true;
  }
  return false;
}

test("screencast ships partial frames while an image is in flight", async ({
  page,
  cdpSession,
}) => {
  const frames: Array<{ at: number; data: string }> = [];
  const waiters = new Set<() => void>();
  cdpSession.on("Page.screencastFrame", (ev: { data: string; sessionId: number }) => {
    frames.push({ at: Date.now(), data: ev.data });
    for (const notify of [...waiters]) notify();
    cdpSession.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
  });

  const waitForFrames = (count: number, budgetMs: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (frames.length >= count) {
        resolve(true);
        return;
      }
      const done = (reached: boolean) => {
        clearTimeout(timer);
        waiters.delete(notify);
        resolve(reached);
      };
      const notify = () => {
        if (frames.length >= count) done(true);
      };
      const timer = setTimeout(() => done(frames.length >= count), budgetMs);
      waiters.add(notify);
    });

  await page.goto(FIXTURE, { waitUntil: "domcontentloaded", timeout: 25000 });

  await cdpSession.send("Page.startScreencast", {
    format: "png",
    maxWidth: 200,
    maxHeight: 200,
    everyNthFrame: 1,
  });

  try {
    await waitForFrames(1, 4_000);
    expect(frames.length).toBeGreaterThan(0);

    const stateAtFirst = (await page.evaluate(`
      (() => {
        const img = document.getElementById("slow");
        return { complete: !!img.complete, loaded: window.__imgLoadedAt > 0 };
      })()
    `)) as { complete: boolean; loaded: boolean };
    expect(stateAtFirst.complete).toBe(false);

    const firstFrame = frames[0];
    if (!firstFrame) throw new Error("no first frame");
    const first = await decodePng(b64Bytes(firstFrame.data));
    const firstPx = pixelAt(first, 100, 100);
    expect(isRed(firstPx)).toBe(false);
    expect(isWhite(firstPx)).toBe(true);

    const deadline = Date.now() + 12_000;
    const sawRed = await waitForRedFrame(frames, waitForFrames, deadline);
    expect(sawRed).toBe(true);

    const loaded = (await page.evaluate(`window.__imgLoadedAt > 0`)) as boolean;
    expect(loaded).toBe(true);
  } finally {
    await cdpSession.send("Page.stopScreencast").catch(() => {});
  }
});
