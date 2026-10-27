// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("iframe-nested-frame-tree", async ({ browser }) => {
  const URL_BASE = process.env.KITESURF_FIXTURE_BASE ?? "http://127.0.0.1:8787";

  const page = await browser.newPage();
  const attached: unknown[] = [];
  const stopped: unknown[] = [];
  const startupOrder = new Map<string, string[]>();
  const recordStartup = (frameId: string, event: string) => {
    const events = startupOrder.get(frameId) ?? [];
    events.push(event);
    startupOrder.set(frameId, events);
  };
  const session = await page.target().createCDPSession();
  await session.send("Page.enable");
  session.on("Page.frameAttached", (p) => {
    attached.push(p);
    recordStartup(p.frameId, "attached");
  });
  session.on("Page.frameStoppedLoading", (p) => stopped.push(p));
  session.on("Page.frameStartedLoading", (p) => recordStartup(p.frameId, "started"));
  session.on("Page.frameNavigated", (p) => recordStartup(p.frame.id, "navigated"));
  session.on("Page.lifecycleEvent", (p) => {
    if (p.name === "init") recordStartup(p.frameId, "init");
  });

  await page.goto(`${URL_BASE}/__fixtures/iframe-nested-l1.html`, {
    timeout: 15000,
  });

  const frames = page.frames();
  expect(frames.length, "expected 3 frames (main + 2 nested)").toBe(3);

  const main = frames.find((f) => f.parentFrame() === null);
  expect(main, "main frame present").toBeTruthy();
  const l2 = frames.filter((f) => f.parentFrame() === main);
  expect(l2.length, "one child under main").toBe(1);
  const l3 = frames.filter((f) => f.parentFrame() === l2[0]);
  expect(l3.length, "one child under l2").toBe(1);
  const l4 = frames.filter((f) => f.parentFrame() === l3[0]);
  expect(l4.length, "leaf has no children").toBe(0);

  expect(main!.url()).toContain("iframe-nested-l1.html");
  expect(l2[0].url()).toContain("iframe-nested-l2.html");
  expect(l3[0].url()).toContain("iframe-nested-l3.html");

  const { frameTree } = await session.send("Page.getFrameTree");
  expect(frameTree.childFrames?.length ?? 0, "main has 1 child").toBe(1);
  const l2Tree = frameTree.childFrames![0];
  expect(l2Tree.childFrames?.length ?? 0, "l2 has 1 child").toBe(1);
  const l3Tree = l2Tree.childFrames![0];
  expect(l3Tree.childFrames?.length ?? 0, "l3 is leaf").toBe(0);
  for (const child of [l2Tree, l3Tree]) {
    expect(startupOrder.get(child.frame.id)).toEqual(["attached", "started", "navigated", "init"]);
  }

  expect(attached.length >= 2, `≥2 frameAttached, got ${attached.length}`).toBeTruthy();
  expect(stopped.length >= 2, `≥2 frameStoppedLoading, got ${stopped.length}`).toBeTruthy();

  const cyclePage = await browser.newPage();
  await cyclePage.goto(`${URL_BASE}/__fixtures/iframe-cycle.html`, {
    timeout: 15000,
  });
  const cycleFrames = cyclePage.frames();
  expect(
    cycleFrames.length,
    `cycle fixture should terminate at MAX_IFRAME_DEPTH; got ${cycleFrames.length}`,
  ).toBeLessThanOrEqual(10);
  expect(cycleFrames.length, "at least main + one iframe").toBeGreaterThanOrEqual(2);
});
