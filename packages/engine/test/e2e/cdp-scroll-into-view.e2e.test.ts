// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// DOM.scrollIntoViewIfNeeded replied {} without scrolling, so puppeteer took it as done and
// skipped its own fallback: chrome-devtools-mcp's click never reached an element below the fold.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const PAGE = `<button id=top>Top</button><div style="height:3000px"></div><button id=far>Far</button><div style="height:3000px"></div>`;

const where = (page: Parameters<typeof setContent>[0], id: string) =>
  page.evaluate((sel: string) => {
    const el = document.getElementById(sel);
    if (!el) throw new Error(`no #${sel}`);
    const r = el.getBoundingClientRect();
    return { scrollY: window.scrollY, top: r.top, bottom: r.bottom, viewport: window.innerHeight };
  }, id);

test("DOM.scrollIntoViewIfNeeded centres an off-screen node and leaves a visible one where it is", async ({
  page,
}) => {
  await setContent(page, PAGE);
  const session = await page.createCDPSession();
  const { root } = await session.send("DOM.getDocument", { depth: -1 });
  const nodeOf = async (selector: string) =>
    (await session.send("DOM.querySelector", { nodeId: root.nodeId, selector })).nodeId;

  await session.send("DOM.scrollIntoViewIfNeeded", { nodeId: await nodeOf("#top") });
  expect((await where(page, "top")).scrollY).toBe(0);

  await session.send("DOM.scrollIntoViewIfNeeded", { nodeId: await nodeOf("#far") });
  const far = await where(page, "far");
  expect(far.scrollY).toBeGreaterThan(0);
  expect(far.top).toBeGreaterThanOrEqual(0);
  expect(far.bottom).toBeLessThanOrEqual(far.viewport);
  expect(Math.abs((far.top + far.bottom) / 2 - far.viewport / 2)).toBeLessThan(far.viewport / 4);

  await expect(session.send("DOM.scrollIntoViewIfNeeded", { nodeId: 987654 })).rejects.toThrow();
}, 60_000);

test("puppeteer's ElementHandle.scrollIntoView brings a node below the fold into the viewport", async ({
  page,
}) => {
  await setContent(page, PAGE);
  const far = await page.$("#far");
  if (!far) throw new Error("no #far");
  expect(await far.isIntersectingViewport()).toBe(false);
  await far.scrollIntoView();
  expect(await far.isIntersectingViewport()).toBe(true);
}, 60_000);

// A scroll container clips what the window would show: the node below sits inside the viewport
// but under the box's fold, and IntersectionObserver (puppeteer's re-check) sees it hidden.
const BOXED = `<div id=box style="height:200px;overflow:auto"><div style="height:400px"></div><button id=inner>Inner</button></div>`;

test("DOM.scrollIntoViewIfNeeded scrolls a node its scroll container hides, though the window would show it", async ({
  page,
}) => {
  await setContent(page, BOXED);
  const geometry = () =>
    page.evaluate(() => {
      const box = document.getElementById("box");
      const inner = document.getElementById("inner");
      if (!box || !inner) throw new Error("no #box or #inner");
      const b = box.getBoundingClientRect();
      const r = inner.getBoundingClientRect();
      return {
        scrollTop: box.scrollTop,
        inBox: r.top >= b.top && r.bottom <= b.top + box.clientHeight,
        inWindow: r.top >= 0 && r.bottom <= window.innerHeight,
      };
    });
  expect(await geometry()).toEqual({ scrollTop: 0, inBox: false, inWindow: true });
  const session = await page.createCDPSession();
  const { root } = await session.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await session.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "#inner",
  });
  await session.send("DOM.scrollIntoViewIfNeeded", { nodeId });
  const after = await geometry();
  expect(after.scrollTop).toBeGreaterThan(0);
  expect(after.inBox).toBe(true);

  const inner = await page.$("#inner");
  if (!inner) throw new Error("no #inner");
  expect(await inner.isIntersectingViewport()).toBe(true);
}, 60_000);
