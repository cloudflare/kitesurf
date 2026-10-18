// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { loadLayoutPage } from "./layout-test-helpers";
import { decodePng } from "./png";

const INLINE_STRUT_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 200px; font-size: 16px; line-height: 19.2px }
  #root > a { font-size: 14px }
  #after { height: 1px; background: #f00 }
</style>
<div id="root"><a href="#">Text</a></div><div id="after"></div>`;

const INLINE_BLOCK_STRUT_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 300px; font-size: 16px; line-height: 25.6px }
  #link { display: inline-block; padding: 8px }
  #box { display: inline-block; width: 36px; height: 36px }
  #after { height: 1px; background: #f00 }
</style>
<div id="root"><a id="link" href="#"><span id="box"></span></a></div><div id="after"></div>`;

const INLINE_SHORT_BOX_STRUT_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 200px; font-size: 16px; line-height: normal }
  #icon { display: inline-block; width: 10px; height: 10px; background: #f00 }
</style>
<div id="root"><span id="icon"></span></div>`;

const INLINE_MULTI_LINE_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 200px; font-size: 16px; line-height: 1.2 }
  #after { height: 1px; background: #f00 }
</style>
<div id="root">Line one<br>Line two<br>Line three<br>Line four<br>Line five<br>Line six<br>Line seven<br>Line eight<br>Line nine<br>Line ten</div><div id="after"></div>`;

const INLINE_WRAPPED_STRUT_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 40px; font-size: 16px; line-height: normal }
  #root > span { display: inline-block; width: 30px; height: 20px }
  #after { height: 1px; background: #f00 }
</style>
<div id="root"><span></span><span></span></div><div id="after"></div>`;

const INLINE_WRAPPED_STRUT_ABSPOS_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 40px; font-size: 16px; line-height: normal; position: relative }
  #root > span { display: inline-block; width: 30px; height: 20px }
  #abs { position: absolute; display: inline-block; width: 10px; height: 10px }
</style>
<div id="root"><span></span><span></span><span id="abs"></span></div>`;

const BORDERED_INLINE_ABSPOS_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { position: relative; border: 10px solid; width: 200px }
  #abs { position: absolute; right: 0; top: 0; width: 20px; height: 20px }
</style>
<div id="root"><span id="abs"></span>text</div>`;

const INLINE_SVG_LINE_HEIGHT_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 200px; line-height: 60px }
  #item { float: left }
  svg { width: 16px; height: 13px }
</style>
<div id="root"><div id="item"><a href="#"><svg id="icon" viewBox="0 0 16 13"><path d="M0 0h16v13H0z" /></svg></a></div></div>`;

const INLINE_REPLACED_LINE_HEIGHT_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 200px; line-height: 60px }
  canvas { width: 10px; height: 10px }
</style>
<div id="root"><canvas id="canvas" width="10" height="10"></canvas></div>`;

const INLINE_REPLACED_NORMAL_LINE_HEIGHT_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  .root { width: 200px; font: 100px/normal serif }
  canvas { width: 10px; height: 10px }
</style>
<div id="text" class="root">x</div>
<div id="replaced" class="root"><canvas width="10" height="10"></canvas></div>`;

const INLINE_MIXED_BOX_ONLY_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 40px; font-size: 16px; line-height: normal }
  #root > span { display: inline-block; width: 30px; height: 20px }
</style>
<div id="root">text<br><span id="box"></span></div>`;

const INLINE_COMPACT_LINE_HEIGHT_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 200px; font-size: 16px; line-height: 0 }
  #root > span { display: inline-block; width: 10px; height: 10px }
</style>
<div id="root"><span></span></div>`;

const INLINE_MIXED_SHORT_BOX_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 40px; font-size: 16px; line-height: normal }
  #root > span { display: inline-block; width: 10px; height: 10px }
</style>
<div id="root">text<br><span id="box"></span></div>`;

const INLINE_MIXED_SHORT_REPLACED_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 40px; font-size: 16px; line-height: normal }
  canvas { width: 10px; height: 10px }
</style>
<div id="root">text<br><canvas id="box" width="10" height="10"></canvas></div>`;

const INLINE_MIXED_EXPLICIT_LINE_HEIGHT_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 40px; font-size: 16px; line-height: 60px }
  #root > span { display: inline-block; width: 10px; height: 10px }
</style>
<div id="root">text<br><span id="box"></span></div>`;

const INLINE_MIXED_EXPLICIT_REPLACED_LINE_HEIGHT_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 40px; font-size: 16px; line-height: 60px }
  canvas { width: 10px; height: 10px }
</style>
<div id="root">text<br><canvas id="box" width="10" height="10"></canvas></div>`;

const INLINE_MIXED_MULTIPLE_BOX_LINES_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 40px; font-size: 16px; line-height: 60px }
  #root > span { display: inline-block; width: 10px; height: 10px }
</style>
<div id="root">text<br><span id="first"></span><br><span id="second"></span></div>`;

// Out-of-flow-only inline formatting contexts do not generate a line box
// (CSS 2.1 §9.4.2).
const OUT_OF_FLOW_ONLY_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 200px; font-size: 16px; line-height: 19.2px }
  #abs { position: absolute }
  #after { height: 1px; background: #f00 }
</style>
<div id="root"><label><span id="abs">Download</span></label></div><div id="after"></div>`;

const IN_FLOW_ONLY_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 200px; font-size: 16px; line-height: 19.2px }
  #after { height: 1px; background: #f00 }
</style>
<div id="root"><label><span id="inflow">Download</span></label></div><div id="after"></div>`;

const OUT_OF_FLOW_STATIC_POSITION_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #pad { height: 7px }
  #root { position: relative; width: 200px; font-size: 16px; line-height: 19.2px }
  #abs { position: absolute; width: 30px; height: 12px; background: #f00 }
</style>
<div id="pad"></div><div id="root"><label><span id="abs"></span></label></div>`;

const OUT_OF_FLOW_INTERLEAVED_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  div { width: 200px; font-size: 16px; line-height: 20px }
  #abs { position: absolute }
</style>
<div id="first">first</div><div id="mid"><label><span id="abs">Download</span></label></div><div id="last">last</div>`;

const OUT_OF_FLOW_AFTER_FORCED_BREAK_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 200px; font-size: 16px; line-height: 20px }
  #abs { position: absolute }
</style>
<div id="root">text<br><br><span id="abs">Download</span></div>`;

const OUT_OF_FLOW_BEFORE_FORCED_BREAK_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  div { width: 200px; font-size: 16px; line-height: 20px }
  .abs { position: absolute }
</style>
<div id="mid">text<br><span class="abs">Download</span><br>x</div>
<div id="first"><span class="abs">Download</span><br>x</div>`;

// Out-of-flow glyphs must not expand an inline ancestor's rect.
const ABSPOS_CHILD_OF_INLINE_LABEL_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { position: relative; width: 400px; font-size: 16px; line-height: 20px }
  #abs { position: absolute; left: 0; top: 0; font-size: 40px; line-height: 40px }
</style>
<div id="root"><label id="label">Hi<span id="abs">wide wide wide</span></label></div>`;

const SR_ONLY_LABEL_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #pad { height: 40px }
  #root { position: relative; width: 200px; font-size: 16px; line-height: 19.2px }
  #abs {
    position: absolute; width: 1px; height: 1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
  }
</style>
<div id="pad"></div><div id="root"><label id="label"><span id="abs">Download</span></label></div>`;

const SR_ONLY_LABEL_FIXED_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #pad { height: 40px }
  #root { position: relative; width: 200px; font-size: 16px; line-height: 19.2px }
  #abs {
    position: fixed; width: 1px; height: 1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;
  }
</style>
<div id="pad"></div><div id="root"><label id="label"><span id="abs">Download</span></label></div>`;

const NESTED_ABSPOS_ANCESTOR_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { position: relative; width: 400px; font-size: 16px; line-height: 20px }
  #abs { position: absolute; left: 0; top: 0; font-size: 40px }
</style>
<div id="root"><label id="label">Hi<span id="abs"><span id="inner">wide wide wide</span></span></label></div>`;

const IN_FLOW_LABEL_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 200px; font-size: 16px; line-height: 19.2px }
</style>
<div id="root"><label id="label"><span id="inflow">Download</span></label></div>`;

const ATOMIC_INLINE_WRAPPERS_HTML = `<!doctype html>
<style>html, body { margin: 0 }</style>
<a id="image-link" href="#"><img width="50" height="50"></a>
<span id="button-wrapper"><button>Go</button></span>
<label id="input-wrapper"><input></label>`;

const labelAndChildRects = (childId: string) => {
  const box = (id: string) => {
    const r = document.getElementById(id)!.getBoundingClientRect();
    return { width: r.width, height: r.height };
  };
  return { label: box("label"), child: box(childId) };
};

test("excludes an abs-pos child's glyphs from its inline ancestor's rect", async ({ page }) => {
  await loadLayoutPage(page, ABSPOS_CHILD_OF_INLINE_LABEL_HTML);
  const result = await page.evaluate(labelAndChildRects, "abs");
  expect(result.label.width).toBeGreaterThan(0);
  expect(result.label.width).toBeLessThan(result.child.width);
  expect(result.label.height).toBeLessThan(result.child.height);
  expect(result.child.width).toBeGreaterThan(0);
  expect(result.child.height).toBeGreaterThan(0);
}, 120_000);

test.for([
  ["absolute", SR_ONLY_LABEL_HTML],
  ["fixed", SR_ONLY_LABEL_FIXED_HTML],
] as const)(
  "reports 0x0 for a label holding only an sr-only %s child",
  { timeout: 120_000 },
  async ([_name, html], { page }) => {
    await loadLayoutPage(page, html);
    const result = await page.evaluate(labelAndChildRects, "abs");
    expect(result.label).toEqual({ width: 0, height: 0 });
    expect([Math.round(result.child.width), Math.round(result.child.height)]).toEqual([1, 1]);
  },
);

test("excludes a nested abs-pos ancestor but still measures its inner child", async ({ page }) => {
  await loadLayoutPage(page, NESTED_ABSPOS_ANCESTOR_HTML);
  const result = await page.evaluate(labelAndChildRects, "inner");
  expect(result.label.width).toBeGreaterThan(0);
  expect(result.label.width).toBeLessThan(result.child.width);
  expect(result.label.height).toBeLessThan(result.child.height);
  expect(result.child.width).toBeGreaterThan(0);
  expect(result.child.height).toBeGreaterThan(0);
}, 120_000);

test("keeps nonzero dimensions for a label holding an in-flow control", async ({ page }) => {
  await loadLayoutPage(page, IN_FLOW_LABEL_HTML);
  const result = await page.evaluate(labelAndChildRects, "inflow");
  expect(result.label.width).toBeGreaterThan(0);
  expect(result.label.height).toBeGreaterThan(0);
  expect(result.child.width).toBeGreaterThan(0);
  expect(result.child.height).toBeGreaterThan(0);
}, 120_000);

test("measures inline wrappers whose only content is an atomic inline", async ({ page }) => {
  await loadLayoutPage(page, ATOMIC_INLINE_WRAPPERS_HTML);
  const rects = await page.evaluate(() =>
    ["image-link", "button-wrapper", "input-wrapper"].map((id) => {
      const rect = document.getElementById(id)!.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }),
  );
  for (const rect of rects) {
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  }
}, 120_000);

test("collapses a wrapper whose only inline content is out-of-flow", async ({ page }) => {
  await loadLayoutPage(page, OUT_OF_FLOW_ONLY_HTML);
  const result = await page.evaluate(() => {
    const root = document.getElementById("root")!.getBoundingClientRect();
    const after = document.getElementById("after")!.getBoundingClientRect();
    return { rootHeight: Math.round(root.height), afterY: Math.round(after.y) };
  });
  expect(result).toEqual({ rootHeight: 0, afterY: 0 });
}, 120_000);

test("keeps the line box when the same wrapper's child is in flow", async ({ page }) => {
  await loadLayoutPage(page, IN_FLOW_ONLY_HTML);
  const result = await page.evaluate(() => {
    const root = document.getElementById("root")!.getBoundingClientRect();
    const after = document.getElementById("after")!.getBoundingClientRect();
    return { rootHeight: Math.round(root.height), afterY: Math.round(after.y) };
  });
  expect(result).toEqual({ rootHeight: 19, afterY: 19 });
}, 120_000);

test("keeps the static position of the abs-pos child of a collapsed wrapper", async ({ page }) => {
  await loadLayoutPage(page, OUT_OF_FLOW_STATIC_POSITION_HTML);
  const result = await page.evaluate(() => {
    const root = document.getElementById("root")!.getBoundingClientRect();
    const abs = document.getElementById("abs")!.getBoundingClientRect();
    return {
      rootY: Math.round(root.y),
      rootHeight: Math.round(root.height),
      abs: [abs.x, abs.y, abs.width, abs.height].map(Math.round),
    };
  });
  expect(result).toEqual({ rootY: 7, rootHeight: 0, abs: [0, 7, 30, 12] });
}, 120_000);

test("does not carry a phantom line into the blocks after a collapsed wrapper", async ({
  page,
}) => {
  await loadLayoutPage(page, OUT_OF_FLOW_INTERLEAVED_HTML);
  const result = await page.evaluate(() => {
    const y = (id: string) => Math.round(document.getElementById(id)!.getBoundingClientRect().y);
    const mid = document.getElementById("mid")!.getBoundingClientRect();
    return {
      firstY: y("first"),
      midY: y("mid"),
      midHeight: Math.round(mid.height),
      lastY: y("last"),
      absY: y("abs"),
    };
  });
  expect(result).toEqual({
    firstY: 0,
    midY: 20,
    midHeight: 0,
    lastY: 20,
    absY: 20,
  });
}, 120_000);

test("still generates a line box for a forced break before an abs-pos child", async ({ page }) => {
  await loadLayoutPage(page, OUT_OF_FLOW_AFTER_FORCED_BREAK_HTML);
  const rootHeight = await page.evaluate(() =>
    Math.round(document.getElementById("root")!.getBoundingClientRect().height),
  );
  expect(rootHeight).toBe(40);
}, 120_000);

test("keeps the line box of an out-of-flow line that ends in a forced break", async ({ page }) => {
  await loadLayoutPage(page, OUT_OF_FLOW_BEFORE_FORCED_BREAK_HTML);
  const heights = await page.evaluate(() =>
    ["mid", "first"].map((id) =>
      Math.round(document.getElementById(id)!.getBoundingClientRect().height),
    ),
  );
  // Chrome: the <br> generates the abspos line's box, mid-flow or first.
  expect(heights).toEqual([60, 40]);
}, 120_000);

test("includes the parent font strut in an inline line box", async ({ page }) => {
  await loadLayoutPage(page, INLINE_STRUT_HTML);
  const [rootHeight, afterY] = await page.evaluate(() => {
    const root = document.getElementById("root")!.getBoundingClientRect();
    const after = document.getElementById("after")!.getBoundingClientRect();
    return [Math.round(root.height), Math.round(after.y)];
  });
  expect(rootHeight).toBe(19);
  expect(afterY).toBe(rootHeight);
}, 120_000);

test("keeps a fractional line-height unrounded across lines", async ({ page }) => {
  await loadLayoutPage(page, INLINE_MULTI_LINE_HTML);
  const [rootHeight, afterY] = await page.evaluate(() => {
    const root = document.getElementById("root")!.getBoundingClientRect();
    const after = document.getElementById("after")!.getBoundingClientRect();
    return [Math.round(root.height), Math.round(after.y)];
  });
  expect(rootHeight).toBe(192);
  expect(afterY).toBe(rootHeight);
}, 120_000);

test("shifts wrapped box-only lines down by the parent-font strut", async ({ page }) => {
  await loadLayoutPage(page, INLINE_WRAPPED_STRUT_HTML);
  const result = await page.evaluate(() => {
    const root = document.getElementById("root")!.getBoundingClientRect();
    const [box1, box2] = Array.from(document.querySelectorAll("#root > span"));
    if (!box1 || !box2) throw new Error("expected two inline boxes");
    const after = document.getElementById("after")!.getBoundingClientRect();
    return {
      rootHeight: Math.round(root.height),
      box1Y: Math.round(box1.getBoundingClientRect().y),
      box2Y: Math.round(box2.getBoundingClientRect().y),
      afterY: Math.round(after.y),
    };
  });
  expect(result.rootHeight).toBe(50);
  expect(result.box2Y).toBeGreaterThan(result.box1Y + 20);
  expect(result.afterY).toBe(result.rootHeight);
}, 120_000);

test("keeps an abs-pos inline child on its wrapped line, not the container top", async ({
  page,
}) => {
  await loadLayoutPage(page, INLINE_WRAPPED_STRUT_ABSPOS_HTML);
  const result = await page.evaluate(() => {
    const root = document.getElementById("root")!.getBoundingClientRect();
    const [, span2] = Array.from(document.querySelectorAll("#root > span"));
    if (!span2) throw new Error("expected a second inline box");
    const abs = document.getElementById("abs")!.getBoundingClientRect();
    return {
      rootHeight: Math.round(root.height),
      span2Y: Math.round(span2.getBoundingClientRect().y),
      absY: Math.round(abs.y),
    };
  });
  expect(result.rootHeight).toBe(50);
  expect(result.absY).toBe(result.span2Y);
  expect(result.absY).toBe(25);
}, 120_000);

test("positions an inset abs-pos child against a bordered inline root's padding box", async ({
  page,
}) => {
  await loadLayoutPage(page, BORDERED_INLINE_ABSPOS_HTML);
  const position = await page.evaluate(() => {
    const rect = document.getElementById("abs")!.getBoundingClientRect();
    return [Math.round(rect.x), Math.round(rect.y)];
  });
  expect(position).toEqual([190, 10]);
}, 120_000);

test("includes the parent font strut around an inline block", async ({ page }) => {
  await loadLayoutPage(page, INLINE_BLOCK_STRUT_HTML);
  const [rootHeight, linkHeight, afterY] = await page.evaluate(() => {
    const root = document.getElementById("root")!.getBoundingClientRect();
    const link = document.getElementById("link")!.getBoundingClientRect();
    const after = document.getElementById("after")!.getBoundingClientRect();
    return [Math.round(root.height), Math.round(link.height), Math.round(after.y)];
  });
  expect(linkHeight).toBeGreaterThan(52);
  expect(afterY).toBe(rootHeight);
}, 120_000);

test("aligns a short inline box to the parent font strut", async ({ page }) => {
  await loadLayoutPage(page, INLINE_SHORT_BOX_STRUT_HTML);
  const result = await page.evaluate(() => {
    const root = document.getElementById("root")!.getBoundingClientRect();
    const icon = document.getElementById("icon")!.getBoundingClientRect();
    return { rootY: root.y, rootBottom: root.bottom, iconY: icon.y, iconBottom: icon.bottom };
  });
  expect(result.iconY).toBeGreaterThan(result.rootY);
  expect(result.iconBottom).toBeLessThanOrEqual(result.rootBottom);
}, 120_000);

test("preserves a block line-height around an inline SVG", async ({ page }) => {
  await loadLayoutPage(page, INLINE_SVG_LINE_HEIGHT_HTML);
  const result = await page.evaluate(() => {
    const item = document.getElementById("item")!.getBoundingClientRect();
    const icon = document.getElementById("icon")!.getBoundingClientRect();
    return {
      item: [
        Math.round(item.x),
        Math.round(item.y),
        Math.round(item.width),
        Math.round(item.height),
      ],
      icon: [
        Math.round(icon.x),
        Math.round(icon.y),
        Math.round(icon.width),
        Math.round(icon.height),
      ],
    };
  });
  expect(result.item).toEqual([0, 0, 16, 60]);
  expect(result.icon[0]).toBe(0);
  expect(result.icon[1]).toBeGreaterThanOrEqual(22);
  expect(result.icon[1]).toBeLessThanOrEqual(23);
  expect(result.icon.slice(2)).toEqual([16, 13]);
}, 120_000);

test("preserves the parent line-height around a replaced inline box", async ({ page }) => {
  await loadLayoutPage(page, INLINE_REPLACED_LINE_HEIGHT_HTML);
  const result = await page.evaluate(() => {
    const root = document.getElementById("root")!.getBoundingClientRect();
    const canvas = document.getElementById("canvas")!.getBoundingClientRect();
    return { rootHeight: Math.round(root.height), canvasY: canvas.y, canvasBottom: canvas.bottom };
  });
  expect(result.rootHeight).toBe(60);
  expect(result.canvasY).toBeGreaterThanOrEqual(0);
  expect(result.canvasBottom).toBeLessThanOrEqual(result.rootHeight);
}, 120_000);

test("uses the natural font line-height around a replaced inline box", async ({ page }) => {
  await loadLayoutPage(page, INLINE_REPLACED_NORMAL_LINE_HEIGHT_HTML);
  await page.evaluate(() => document.fonts.ready);
  const heights = await page.evaluate(() =>
    ["text", "replaced"].map((id) =>
      Math.round(document.getElementById(id)!.getBoundingClientRect().height),
    ),
  );
  expect(heights[1]).toBe(heights[0]);
}, 120_000);

test("keeps the parent strut on a mixed text and box-only line", async ({ page }) => {
  await loadLayoutPage(page, INLINE_MIXED_BOX_ONLY_HTML);
  const result = await page.evaluate(() => {
    const root = document.getElementById("root")!.getBoundingClientRect();
    const box = document.getElementById("box")!.getBoundingClientRect();
    return { rootHeight: Math.round(root.height), boxY: Math.round(box.y) };
  });
  // Chrome: the 22px text line, then the 20px box on the baseline of the
  // strut (17px ascent, 5px descent), which it overtops: 20 + 5.
  expect(result).toEqual({ rootHeight: 47, boxY: 22 });
}, 120_000);

test("does not expand an explicit compact line height to natural metrics", async ({ page }) => {
  await loadLayoutPage(page, INLINE_COMPACT_LINE_HEIGHT_HTML);
  const rootHeight = await page.evaluate(() =>
    Math.round(document.getElementById("root")!.getBoundingClientRect().height),
  );
  expect(rootHeight).toBe(10);
}, 120_000);

test.for([
  ["inline block", INLINE_MIXED_SHORT_BOX_HTML],
  ["replaced box", INLINE_MIXED_SHORT_REPLACED_HTML],
] as const)(
  "keeps a short mixed %s on the parent strut",
  { timeout: 120_000 },
  async ([_name, html], { page }) => {
    await loadLayoutPage(page, html);
    const result = await page.evaluate(() => {
      const root = document.getElementById("root")!.getBoundingClientRect();
      const box = document.getElementById("box")!.getBoundingClientRect();
      return { rootHeight: Math.round(root.height), boxY: Math.round(box.y) };
    });
    // Chrome: 22px text line, then a full 22px strut line with the 10px box
    // on its baseline, 17px below the line top.
    expect(result).toEqual({ rootHeight: 44, boxY: 29 });
  },
);

test.for([
  ["inline block", INLINE_MIXED_EXPLICIT_LINE_HEIGHT_HTML],
  ["replaced box", INLINE_MIXED_EXPLICIT_REPLACED_LINE_HEIGHT_HTML],
] as const)(
  "preserves an explicit line-height on a mixed %s line",
  { timeout: 120_000 },
  async ([_name, html], { page }) => {
    await loadLayoutPage(page, html);
    const result = await page.evaluate(() => {
      const root = document.getElementById("root")!.getBoundingClientRect();
      const box = document.getElementById("box")!.getBoundingClientRect();
      return { rootHeight: Math.round(root.height), boxY: Math.round(box.y) };
    });
    // Chrome: the box sits on the strut's baseline, the 19px half-leading
    // plus the 17px ascent below the 60px line's top.
    expect(result).toEqual({ rootHeight: 120, boxY: 86 });
  },
);

test("keeps accumulated strut offsets between mixed box-only lines", async ({ page }) => {
  await loadLayoutPage(page, INLINE_MIXED_MULTIPLE_BOX_LINES_HTML);
  const result = await page.evaluate(() => {
    const root = document.getElementById("root")!.getBoundingClientRect();
    const first = document.getElementById("first")!.getBoundingClientRect();
    const second = document.getElementById("second")!.getBoundingClientRect();
    return {
      rootHeight: Math.round(root.height),
      firstY: Math.round(first.y),
      secondY: Math.round(second.y),
    };
  });
  // Chrome: each box sits on its own line's strut baseline, 36px down.
  expect(result).toEqual({ rootHeight: 180, firstY: 86, secondY: 146 });
}, 120_000);

const NORMAL_LINE_HEIGHT_BASELINE_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #text, #ref { font-size: 16px; line-height: normal }
  #ref { line-height: 22px }
</style>
<div id="text"><span id="a">Text</span></div>
<div id="ref"><span id="b">Text</span></div>`;

const OUTSIDE_MARKER_BASELINE_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  ol, ul { font-size: 16px; line-height: normal }
</style>
<ol id="block"><li>Two<div></div></ol>
<ol id="inline"><li>Two</ol>`;

const EMPTY_LINE_WITH_ABSPOS_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { position: relative; width: 100px; font-size: 16px; line-height: normal }
  #abs { position: absolute; width: 10px; height: 10px }
  #zero { width: 100px; line-height: 0; position: relative }
  #after { height: 1px }
</style>
<div id="root"><span><span id="abs"></span></span></div>
<div id="zero"><span><div id="abs2" style="position: absolute; width: 10px; height: 10px"></div></span></div>
<div id="after"></div>`;

const VERTICAL_ALIGN_TOP_BOXES_HTML = `<!doctype html>
<style>
  html, body { margin: 0 }
  #root { width: 100px; font-size: 16px; line-height: normal }
  #root > span { display: inline-block; width: 40px; height: 40px; vertical-align: top }
</style>
<div id="root"><span></span><span></span></div>`;

test("rounds natural font metrics so a normal line-height keeps Chrome's baseline", async ({
  page,
}) => {
  await loadLayoutPage(page, NORMAL_LINE_HEIGHT_BASELINE_HTML);
  const result = await page.evaluate(() => {
    const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    return {
      textHeight: rect("text").height,
      spanOffset: rect("a").y - rect("text").y,
      refSpanOffset: rect("b").y - rect("ref").y,
    };
  });
  expect(result.textHeight).toBe(22);
  expect(result.spanOffset).toBeCloseTo(result.refSpanOffset, 3);
}, 120_000);

test("paints an outside list marker on the first line's baseline", async ({ page }) => {
  await loadLayoutPage(page, OUTSIDE_MARKER_BASELINE_HTML);
  const png = await decodePng(new Uint8Array((await page.screenshot()) as Uint8Array));
  const rows = await page.evaluate(() => {
    const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    return { block: rect("block"), inline: rect("inline") };
  });
  const firstInk = (top: number, bottom: number) => {
    for (let y = Math.round(top); y < Math.round(bottom); y++) {
      for (let x = 0; x < 40; x++) {
        const i = (y * png.width + x) * 4;
        if ((png.data[i] ?? 255) < 128) return y - Math.round(top);
      }
    }
    return -1;
  };
  const blockInk = firstInk(rows.block.y, rows.block.bottom);
  const inlineInk = firstInk(rows.inline.y, rows.inline.bottom);
  expect(blockInk).toBeGreaterThan(0);
  expect(blockInk).toBe(inlineInk);
}, 120_000);

test("gives a line holding only an abs-pos placeholder zero height", async ({ page }) => {
  await loadLayoutPage(page, EMPTY_LINE_WITH_ABSPOS_HTML);
  const result = await page.evaluate(() => {
    const rect = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    return {
      rootHeight: rect("root").height,
      zeroHeight: rect("zero").height,
      abs2Y: rect("abs2").y,
      afterY: rect("after").y,
    };
  });
  expect(result.rootHeight).toBe(0);
  expect(result.zeroHeight).toBe(0);
  expect(result.abs2Y).toBe(0);
  expect(result.afterY).toBe(0);
}, 120_000);

test("does not push vertical-align: top boxes below the strut descent", async ({ page }) => {
  await loadLayoutPage(page, VERTICAL_ALIGN_TOP_BOXES_HTML);
  const result = await page.evaluate(() => {
    const root = document.getElementById("root")!.getBoundingClientRect();
    const [a, b] = Array.from(document.querySelectorAll("#root > span")).map((el) =>
      el.getBoundingClientRect(),
    );
    if (!a || !b) throw new Error("expected two inline boxes");
    return { rootHeight: root.height, aY: a.y, bY: b.y };
  });
  expect(result.rootHeight).toBe(40);
  expect(result.aY).toBe(0);
  expect(result.bY).toBe(0);
}, 120_000);
