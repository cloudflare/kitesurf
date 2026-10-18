// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("element-scroll-demo", async ({ page }) => {
  const html = `<!doctype html><html><body style='margin:0;height:5000px'>
  <div id='outer' style='width:300px;height:300px;overflow:scroll;border:1px solid red;margin-top:100px'>
    <div id='inner' style='width:1000px;height:1500px;background:linear-gradient(red,blue)'></div>
  </div>
</body></html>`;
  await page.goto("data:text/html," + encodeURIComponent(html), { waitUntil: "load" });

  const dims = await page.evaluate(() => {
    const o = document.getElementById("outer");
    return {
      sw: o.scrollWidth,
      sh: o.scrollHeight,
      cw: o.clientWidth,
      ch: o.clientHeight,
      st: o.scrollTop,
      sl: o.scrollLeft,
    };
  });
  expect(
    dims.cw > 0 && dims.cw <= 302,
    `clientWidth reflects padding-box (got ${dims.cw})`,
  ).toBeTruthy();
  expect(
    dims.ch > 0 && dims.ch <= 302,
    `clientHeight reflects padding-box (got ${dims.ch})`,
  ).toBeTruthy();
  expect(
    dims.sw >= 998 && dims.sw <= 1002,
    `scrollWidth includes overflow content (got ${dims.sw}, content is 1000)`,
  ).toBeTruthy();
  expect(
    dims.sh >= 1498 && dims.sh <= 1502,
    `scrollHeight includes overflow content (got ${dims.sh}, content is 1500)`,
  ).toBeTruthy();
  expect(dims.st === 0 && dims.sl === 0, "initial scrollTop/Left are 0").toBeTruthy();

  const writes = await page.evaluate(async () => {
    const o = document.getElementById("outer");
    o.scrollTop = 200;
    o.scrollLeft = 100;
    await new Promise((r) => setTimeout(r, 30));
    const at = { st: o.scrollTop, sl: o.scrollLeft };
    o.scrollTop = 9999;
    o.scrollLeft = 9999;
    await new Promise((r) => setTimeout(r, 30));
    const clampedHi = { st: o.scrollTop, sl: o.scrollLeft };
    o.scrollTop = -50;
    o.scrollLeft = -50;
    await new Promise((r) => setTimeout(r, 30));
    const clampedLo = { st: o.scrollTop, sl: o.scrollLeft };
    return { at, clampedHi, clampedLo };
  });
  expect(
    writes.at.st === 200 && writes.at.sl === 100,
    "Element.scrollTop/Left writes round-trip",
  ).toBeTruthy();
  expect(
    writes.clampedHi.st > 0 && writes.clampedHi.st < 9999,
    `out-of-range scrollTop clamps (got ${writes.clampedHi.st})`,
  ).toBeTruthy();
  expect(
    writes.clampedLo.st === 0 && writes.clampedLo.sl === 0,
    "negative scrollTop/Left clamps to 0",
  ).toBeTruthy();

  const events = await page.evaluate(async () => {
    const o = document.getElementById("outer");
    o.scrollTop = 0;
    const evs = [];
    const onScroll = (e) => evs.push({ type: e.type, target: e.target.id, isTrusted: e.isTrusted });
    o.addEventListener("scroll", onScroll);
    o.addEventListener("scrollend", onScroll);
    let winSaw = false;
    const onWinScroll = () => {
      winSaw = true;
    };
    window.addEventListener("scroll", onWinScroll, { capture: false });
    o.scrollTop = 500;
    await new Promise((r) => setTimeout(r, 80));
    o.removeEventListener("scroll", onScroll);
    o.removeEventListener("scrollend", onScroll);
    window.removeEventListener("scroll", onWinScroll);
    return { evs, winSaw };
  });
  expect(
    events.evs.some((e) => e.type === "scroll" && e.target === "outer"),
    "scroll event fires on the element",
  ).toBeTruthy();
  expect(
    events.evs.some((e) => e.type === "scrollend" && e.target === "outer"),
    "scrollend fires after settle",
  ).toBeTruthy();
  expect(
    events.evs.every((e) => e.isTrusted === true),
    "element scroll events are trusted",
  ).toBeTruthy();
  expect(
    !events.winSaw,
    "element-only scroll doesn't fire window listener (target stays on element)",
  ).toBeTruthy();

  const outerRect = await page.evaluate(() => {
    const r = document.getElementById("outer").getBoundingClientRect();
    return { left: r.left, top: r.top };
  });

  await page.evaluate(() => {
    document.getElementById("outer").scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await page.mouse.move(outerRect.left + 50, outerRect.top + 50);
  await page.mouse.wheel({ deltaY: 200 });
  await new Promise((r) => setTimeout(r, 60));
  const w1 = await page.evaluate(() => ({
    st: document.getElementById("outer").scrollTop,
    win: window.scrollY,
  }));
  expect(
    w1.st === 200 && w1.win === 0,
    `wheel over container scrolls container, not viewport (st=${w1.st}, win=${w1.win})`,
  ).toBeTruthy();

  await page.evaluate(() => {
    document.getElementById("outer").scrollTop = 9999;
  });
  const max = await page.evaluate(() => document.getElementById("outer").scrollTop);
  await page.mouse.wheel({ deltaY: 400 });
  await new Promise((r) => setTimeout(r, 60));
  const w2 = await page.evaluate(() => ({
    st: document.getElementById("outer").scrollTop,
    win: window.scrollY,
  }));
  expect(
    w2.st === max && w2.win === 400,
    `wheel past container's bottom bubbles to viewport (st stayed ${w2.st}, win=${w2.win})`,
  ).toBeTruthy();

  await page.evaluate(() => {
    document.getElementById("outer").scrollTop = 500;
    window.scrollTo(0, 0);
  });
  await page.mouse.wheel({ deltaY: -100 });
  await new Promise((r) => setTimeout(r, 60));
  const w3 = await page.evaluate(() => document.getElementById("outer").scrollTop);
  expect(w3 === 400, `negative wheel deltaY scrolls up (got ${w3} from 500)`).toBeTruthy();

  await page.evaluate(() => {
    document.getElementById("outer").scrollLeft = 0;
    document.getElementById("outer").scrollTop = 0;
  });
  await page.mouse.wheel({ deltaX: 50, deltaY: 0 });
  await new Promise((r) => setTimeout(r, 60));
  const w4 = await page.evaluate(() => document.getElementById("outer").scrollLeft);
  expect(w4 === 50, `horizontal wheel scrolls horizontally (got scrollLeft=${w4})`).toBeTruthy();
});
