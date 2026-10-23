// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Frame } from "@cloudflare/puppeteer";
import { expect, test } from "../harness";

type FrameWithId = Frame & { _id?: string; id?: string };
type AttachedFrame = { frameId: string };
type NavigatedFrame = { frame: { id: string } };
type FrameTree = {
  frame: { id: string };
  childFrames?: Array<{ frame: { parentId?: string; url?: string } }>;
};
type ResourceTree = { resources: unknown[]; childFrames?: Array<{ resources: unknown[] }> };
type IframeTarget = { type: string; targetId: string; openerFrameId?: string };

function assertFrameIds(frames: Frame[]): void {
  const ids = (frames as FrameWithId[]).map((frame) => frame._id ?? frame.id);
  expect(new Set(ids).size, "frame ids should be unique").toBe(3);
  for (const id of ids) expect(id && id.length > 0, "frameId nonempty").toBeTruthy();
}

function assertFrameHierarchy(frames: Frame[]): void {
  const main = frames.find((frame) => frame.parentFrame() === null);
  expect(main, "must find a main frame").toBeTruthy();
  const children = frames.filter((frame) => frame.parentFrame() === main);
  expect(children.length, "two child frames under main").toBe(2);
}

function assertFrameEvents(attached: AttachedFrame[], navigated: NavigatedFrame[]): void {
  expect(attached.length >= 2, "expected at least 2 frameAttached events").toBeTruthy();
  expect(navigated.length >= 3, "expected at least 3 frameNavigated events").toBeTruthy();
  for (const event of attached) {
    const navigation = navigated.find((entry) => entry.frame.id === event.frameId);
    expect(
      navigation,
      `frameNavigated should follow frameAttached for ${event.frameId}`,
    ).toBeTruthy();
  }
}

function assertFrameTree(frameTree: FrameTree): void {
  const children = frameTree.childFrames ?? [];
  expect(frameTree.childFrames?.length ?? 0, "frameTree has 2 children").toBe(2);
  for (const child of children) {
    expect(child.frame.parentId, "child's parentId matches main frame's id").toBe(
      frameTree.frame.id,
    );
    expect(child.frame.url, "child frame has a url").toBeTruthy();
  }
}

function assertResourceTree(resourceTree: ResourceTree): void {
  expect(resourceTree.childFrames?.length ?? 0).toBe(2);
  expect(resourceTree.resources).toEqual([]);
  for (const child of resourceTree.childFrames ?? []) expect(child.resources).toEqual([]);
}

function assertIframeTargets(iframeTargets: IframeTarget[]): void {
  expect(iframeTargets.length, "two iframe-typed targets").toBe(2);
  for (const target of iframeTargets) {
    expect(target.targetId, "iframe target has id").toBeTruthy();
    expect(target.openerFrameId, "iframe target carries openerFrameId").toBeTruthy();
  }
}

test("iframe-frame-tree-demo", async ({ page }) => {
  const URL_BASE = process.env.KITESURF_FIXTURE_BASE ?? "http://127.0.0.1:8787";

  const attached = [];
  const navigated = [];
  const session = await page.target().createCDPSession();
  await session.send("Page.enable");
  session.on("Page.frameAttached", (p) => attached.push(p));
  session.on("Page.frameNavigated", (p) => navigated.push(p));

  await page.goto(`${URL_BASE}/__fixtures/iframe-host.html`, { timeout: 15000 });

  const frames = page.frames();
  console.log("[iframe-demo] frames =", frames.length);
  expect(frames.length, "expected 1 main + 2 child frames").toBe(3);
  assertFrameIds(frames);
  assertFrameHierarchy(frames);

  console.log(
    "[iframe-demo] frameAttached =",
    attached.length,
    "frameNavigated =",
    navigated.length,
  );
  assertFrameEvents(attached, navigated);

  const { frameTree } = await session.send("Page.getFrameTree");
  assertFrameTree(frameTree);

  const { frameTree: resourceTree } = await session.send("Page.getResourceTree");
  assertResourceTree(resourceTree);

  const { targetInfos } = await session.send("Target.getTargets");
  const iframeTargets = targetInfos.filter((t) => t.type === "iframe");
  console.log("[iframe-demo] iframe Target.* entries =", iframeTargets.length);
  assertIframeTargets(iframeTargets);
});
