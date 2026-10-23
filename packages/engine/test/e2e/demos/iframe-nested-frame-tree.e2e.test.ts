// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

import type { Browser, CDPSession, Frame } from "@cloudflare/puppeteer";

type NestedFrameTree = {
  frame: { id: string };
  childFrames?: NestedFrameTree[];
};

function recordStartup(startupOrder: Map<string, string[]>, frameId: string, event: string): void {
  const events = startupOrder.get(frameId) ?? [];
  events.push(event);
  startupOrder.set(frameId, events);
}

function listenForStartupEvents(
  session: CDPSession,
  startupOrder: Map<string, string[]>,
  attached: unknown[],
  stopped: unknown[],
): void {
  session.on("Page.frameAttached", (event) => {
    attached.push(event);
    recordStartup(startupOrder, event.frameId, "attached");
  });
  session.on("Page.frameStoppedLoading", (event) => stopped.push(event));
  session.on("Page.frameStartedLoading", (event) =>
    recordStartup(startupOrder, event.frameId, "started"),
  );
  session.on("Page.frameNavigated", (event) =>
    recordStartup(startupOrder, event.frame.id, "navigated"),
  );
  session.on("Page.lifecycleEvent", (event) => {
    if (event.name === "init") recordStartup(startupOrder, event.frameId, "init");
  });
}

function assertNestedFrames(frames: Frame[]): void {
  expect(frames.length, "expected 3 frames (main + 2 nested)").toBe(3);

  const main = frames.find((frame) => frame.parentFrame() === null);
  expect(main, "main frame present").toBeTruthy();
  const levelTwo = frames.filter((frame) => frame.parentFrame() === main);
  expect(levelTwo.length, "one child under main").toBe(1);
  const levelThree = frames.filter((frame) => frame.parentFrame() === levelTwo[0]);
  expect(levelThree.length, "one child under l2").toBe(1);
  const levelFour = frames.filter((frame) => frame.parentFrame() === levelThree[0]);
  expect(levelFour.length, "leaf has no children").toBe(0);

  expect(main!.url()).toContain("iframe-nested-l1.html");
  expect(levelTwo[0].url()).toContain("iframe-nested-l2.html");
  expect(levelThree[0].url()).toContain("iframe-nested-l3.html");
}

function nestedChildCount(tree: NestedFrameTree): number {
  return tree.childFrames?.length ?? 0;
}

function firstNestedChild(tree: NestedFrameTree): NestedFrameTree {
  return tree.childFrames![0];
}

function assertNestedFrameTree(tree: NestedFrameTree, startupOrder: Map<string, string[]>): void {
  expect(nestedChildCount(tree), "main has 1 child").toBe(1);
  const levelTwo = firstNestedChild(tree);
  expect(nestedChildCount(levelTwo), "l2 has 1 child").toBe(1);
  const levelThree = firstNestedChild(levelTwo);
  expect(nestedChildCount(levelThree), "l3 is leaf").toBe(0);
  for (const child of [levelTwo, levelThree]) {
    expect(startupOrder.get(child.frame.id)).toEqual(["attached", "started", "navigated", "init"]);
  }
}

async function assertCycleFixture(browser: Browser, urlBase: string): Promise<void> {
  const cyclePage = await browser.newPage();
  await cyclePage.goto(`${urlBase}/__fixtures/iframe-cycle.html`, {
    timeout: 15000,
  });
  const cycleFrames = cyclePage.frames();
  expect(
    cycleFrames.length,
    `cycle fixture should terminate at MAX_IFRAME_DEPTH; got ${cycleFrames.length}`,
  ).toBeLessThanOrEqual(10);
  expect(cycleFrames.length, "at least main + one iframe").toBeGreaterThanOrEqual(2);
}

test("iframe-nested-frame-tree", async ({ browser }) => {
  const URL_BASE = process.env.KITESURF_FIXTURE_BASE ?? "http://127.0.0.1:8787";

  const page = await browser.newPage();
  const attached: unknown[] = [];
  const stopped: unknown[] = [];
  const startupOrder = new Map<string, string[]>();
  const session = await page.target().createCDPSession();
  await session.send("Page.enable");
  listenForStartupEvents(session, startupOrder, attached, stopped);

  await page.goto(`${URL_BASE}/__fixtures/iframe-nested-l1.html`, {
    timeout: 15000,
  });

  assertNestedFrames(page.frames());

  const { frameTree } = await session.send("Page.getFrameTree");
  assertNestedFrameTree(frameTree, startupOrder);

  expect(attached.length >= 2, `≥2 frameAttached, got ${attached.length}`).toBeTruthy();
  expect(stopped.length >= 2, `≥2 frameStoppedLoading, got ${stopped.length}`).toBeTruthy();

  await assertCycleFixture(browser, URL_BASE);
});
