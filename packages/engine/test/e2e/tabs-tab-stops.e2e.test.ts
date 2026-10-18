// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const HTML = `<!doctype html><html><body style="margin:0;font:16px/24px ui-monospace,monospace">
<pre style="margin:0;padding:0" id="pre"><span id="l1">\t\t</span><span id="t1">X</span>
<span id="l2">                </span><span id="t2">Y</span>
</pre></body></html>`;

test("tabs advance to tab stops, matching 8-space indentation", async ({ page }) => {
  await page.goto(`data:text/html,${encodeURIComponent(HTML)}`, { timeout: 15000 });
  const raw = await page.evaluate(`(() => {
    const g = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { x: Math.round(b.x*100)/100, w: Math.round(b.width*100)/100 }; };
    return JSON.stringify({ l1: g('l1'), t1: g('t1'), l2: g('l2'), t2: g('t2') });
  })()`);
  expect(typeof raw, "geometry probe must return a JSON string").toBe("string");
  const r = JSON.parse(raw as string) as {
    l1: { x: number; w: number };
    t1: { x: number; w: number };
    l2: { x: number; w: number };
    t2: { x: number; w: number };
  };
  expect(
    Math.abs(r.t1.x - r.t2.x),
    `t1.x=${r.t1.x} t2.x=${r.t2.x} l1.w=${r.l1.w} l2.w=${r.l2.w}`,
  ).toBeLessThan(0.6);
  expect(r.t1.x, `text after two tabs starts at a tab stop (t1.x=${r.t1.x})`).toBeGreaterThan(100);
  expect(r.l1.w, `tab run width (l1.w=${r.l1.w})`).toBeGreaterThan(120);
});

const PROPORTIONAL_HTML = `<!doctype html><html><body style="margin:0"><pre style="margin:0;font:16px/24px sans-serif"><span>iiiiiiii\t</span><span id="near">X</span>
<span>                </span><span id="control">Y</span></pre></body></html>`;

test("a proportional tab near a stop advances to the following stop", async ({ page }) => {
  await page.goto(`data:text/html,${encodeURIComponent(PROPORTIONAL_HTML)}`, { timeout: 15000 });
  const raw = await page.evaluate(`JSON.stringify({
    near: document.getElementById('near').getBoundingClientRect().x,
    control: document.getElementById('control').getBoundingClientRect().x,
  })`);
  expect(typeof raw, "geometry probe must return a JSON string").toBe("string");
  const r = JSON.parse(raw as string) as { near: number; control: number };
  expect(Math.abs(r.near - r.control), `near.x=${r.near} control.x=${r.control}`).toBeLessThan(0.6);
});

const SHRINK_HTML = `<!doctype html><html><body style="margin:0;font:16px/24px ui-monospace,monospace">
<div id="tabbox" style="display:inline-block"><pre style="margin:0;padding:0">\t<span id="tabtext">X</span></pre></div>
<div id="spacebox" style="display:inline-block"><pre style="margin:0;padding:0">        <span id="spacetext">X</span></pre></div>
</body></html>`;

test("shrink-to-fit width contains the text after a tab", async ({ page }) => {
  await page.goto(`data:text/html,${encodeURIComponent(SHRINK_HTML)}`, { timeout: 15000 });
  const raw = await page.evaluate(`(() => {
    const g = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { x: Math.round(b.x*100)/100, w: Math.round(b.width*100)/100 }; };
    return JSON.stringify({ tabbox: g('tabbox'), tabtext: g('tabtext'), spacebox: g('spacebox') });
  })()`);
  expect(typeof raw, "geometry probe must return a JSON string").toBe("string");
  const r = JSON.parse(raw as string) as {
    tabbox: { x: number; w: number };
    tabtext: { x: number; w: number };
    spacebox: { x: number; w: number };
  };
  expect(
    r.tabtext.x - r.tabbox.x,
    `letter after the tab must sit at the stop (tabtext.x=${r.tabtext.x} tabbox.x=${r.tabbox.x})`,
  ).toBeGreaterThan(50);
  expect(
    r.tabtext.x + r.tabtext.w,
    `letter must end inside the box (box right=${r.tabbox.x + r.tabbox.w})`,
  ).toBeLessThanOrEqual(r.tabbox.x + r.tabbox.w + 0.5);
  expect(
    Math.abs(r.tabbox.w - r.spacebox.w),
    `tab box (${r.tabbox.w}) must measure like the 8-space control (${r.spacebox.w})`,
  ).toBeLessThan(1);
});

const WRAP_HTML = `<!doctype html><html><body style="margin:0;font:16px/24px ui-monospace,monospace">
<div id="box" style="width:200px"><pre id="pre" style="margin:0;padding:0;white-space:pre-wrap">\t<span id="w1">alpha</span> <span id="w2">beta</span> <span id="w3">gamma</span></pre></div>
</body></html>`;

test("constrained pre-wrap keeps words inside the box after a tab", async ({ page }) => {
  await page.goto(`data:text/html,${encodeURIComponent(WRAP_HTML)}`, { timeout: 15000 });
  const raw = await page.evaluate(`(() => {
    const g = (id) => { const b = document.getElementById(id).getBoundingClientRect(); return { x: Math.round(b.x*100)/100, right: Math.round(b.right*100)/100 }; };
    return JSON.stringify({ box: g('box'), w1: g('w1'), w2: g('w2'), w3: g('w3') });
  })()`);
  expect(typeof raw, "geometry probe must return a JSON string").toBe("string");
  const r = JSON.parse(raw as string) as Record<
    "box" | "w1" | "w2" | "w3",
    { x: number; right: number }
  >;
  for (const id of ["w1", "w2", "w3"] as const) {
    expect(
      r[id].right,
      `${id} must stay inside the box (right=${r[id].right} box=${r.box.right})`,
    ).toBeLessThanOrEqual(r.box.right + 0.5);
  }
  expect(
    r.w1.x - r.box.x,
    `first word must start at the tab stop (w1.x=${r.w1.x})`,
  ).toBeGreaterThan(50);
});
