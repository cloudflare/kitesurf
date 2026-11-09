// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import html from "./html/measurement.html?raw";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("offsetWidth/Height and ResizeObserver report the real box", async ({ page }) => {
  await page.setViewport({ width: 600, height: 300 });
  await setContent(page, html, { waitUntil: "domcontentloaded" });

  expect(
    await page.evaluate(() => {
      const box = document.getElementById("box")!;
      const hidden = document.getElementById("hidden")!;
      return {
        offset: [box.offsetWidth, box.offsetHeight],
        client: [box.clientWidth, box.clientHeight],
        hidden: [hidden.offsetWidth, hidden.offsetHeight],
      };
    }),
  ).toEqual({ offset: [330, 110], client: [320, 100], hidden: [0, 0] });

  await page
    .waitForFunction(() => ((globalThis as any).__ks_ro?.length ?? 0) >= 1, {
      timeout: 10_000,
    })
    .catch(() => {});
  await sleep(300);
  expect(await page.evaluate(() => (globalThis as any).__ks_ro)).toEqual([[300, 80]]);

  await page.evaluate(() => (globalThis as any).__ks_grow());
  await page
    .waitForFunction(() => ((globalThis as any).__ks_ro?.length ?? 0) >= 2, {
      timeout: 15_000,
    })
    .catch(() => {});
  await sleep(700);
  expect(await page.evaluate(() => (globalThis as any).__ks_ro)).toEqual([
    [300, 80],
    [500, 80],
  ]);
}, 120_000);

const transformed = `<!doctype html><style>
  body { margin: 0 }
  .tall { position: absolute; width: 158px; height: 804px; transform: scale(0.75, 0.5625) }
  #moving { left: 400px; transition: transform 3s linear }
  #moving.go { transform: none }
  #host { position: absolute; left: 200px; width: 100px; height: 60px;
          transform: rotate(90deg) scale(2) }
  #child { width: 40px; height: 20px; padding: 5px; border: 1px solid }
  #word { padding: 0 3px }
  #padded { position: absolute; top: 600px; width: 100px; height: 50px; padding: 10px;
            border: 5px solid; overflow: hidden; transform: scale(0.5) }
  #padded > div { height: 200px }
</style>
<div id="padded"><div></div></div>
<div id="scaled" class="tall">a</div>
<div id="host"><div id="child"></div><span id="word">word</span></div>
<div id="moving" class="tall">b</div>`;

// A popover that measures itself while its scale-in transition runs must read its full size,
// or it skips the viewport clamp and hangs off-screen.
test("offset and client sizes ignore CSS transforms", async ({ page }) => {
  await page.setViewport({ width: 800, height: 900 });
  await setContent(page, transformed);

  const still = await page.evaluate(() => {
    const $ = (id: string) => document.getElementById(id)!;
    const scaled = $("scaled").getBoundingClientRect();
    const word = $("word").getBoundingClientRect();
    return {
      scaled: [$("scaled").offsetWidth, $("scaled").offsetHeight],
      scaledClient: [$("scaled").clientWidth, $("scaled").clientHeight],
      scaledRect: [scaled.width, scaled.height],
      host: [$("host").offsetWidth, $("host").offsetHeight, $("host").offsetLeft],
      child: [$("child").offsetWidth, $("child").offsetHeight],
      childOffset: [$("child").offsetTop, $("child").offsetLeft],
      wordIsUnrotated: $("word").offsetWidth > $("word").offsetHeight,
      wordRectIsRotated: word.height > word.width,
      wordLeft: $("word").offsetLeft,
      wordTop: $("word").offsetTop,
      padded: [$("padded").offsetWidth, $("padded").offsetHeight],
      paddedClient: [$("padded").clientWidth, $("padded").clientHeight],
      paddedScroll: [$("padded").scrollWidth, $("padded").scrollHeight],
      paddedRect: [$("padded").getBoundingClientRect().width],
    };
  });
  expect(still).toMatchObject({
    scaled: [158, 804],
    scaledClient: [158, 804],
    scaledRect: [118.5, 452.25],
    host: [100, 60, 200],
    child: [52, 32],
    childOffset: [0, 0],
    wordIsUnrotated: true,
    wordRectIsRotated: true,
    wordLeft: 0,
    // The padding box and the scrollable overflow are in the element's own pixels too: only
    // the client rect, 65px wide, shows the scale.
    padded: [130, 80],
    paddedClient: [120, 70],
    paddedScroll: [120, 220],
    paddedRect: [65],
  });
  expect(still.wordTop, "the span sits on the line below #child").toBeGreaterThanOrEqual(32);
  expect(still.wordTop).toBeLessThan(40);

  const mid = await page.evaluate(async () => {
    const moving = document.getElementById("moving")!;
    moving.classList.add("go");
    moving.getBoundingClientRect(); // start the transition now, not at the next frame
    await new Promise((r) => setTimeout(r, 300));
    return {
      offset: [moving.offsetWidth, moving.offsetHeight],
      client: [moving.clientWidth, moving.clientHeight],
      rectHeight: moving.getBoundingClientRect().height,
    };
  });
  expect(mid.rectHeight, `still scaling: ${JSON.stringify(mid)}`).toBeGreaterThan(452.25);
  expect(mid.rectHeight, `still scaling: ${JSON.stringify(mid)}`).toBeLessThan(804);
  expect(mid).toMatchObject({ offset: [158, 804], client: [158, 804] });
}, 120_000);

// The poll skips while no resolve has run. A viewport change relays out with no DOM
// mutation at all, so it reaches observers through the layout epoch alone.
test("ResizeObserver reports a viewport-driven resize after idle polls", async ({ page }) => {
  await page.setViewport({ width: 600, height: 300 });
  await setContent(
    page,
    `<!doctype html><style>body { margin: 0 }</style><div id="half" style="width: 50%; height: 10px"></div><script>
      window.__ro = [];
      new ResizeObserver((entries) => {
        for (const entry of entries) window.__ro.push(Math.round(entry.contentRect.width));
      }).observe(document.getElementById("half"));
    </script>`,
  );
  const reported = () => {
    const ro: unknown = Reflect.get(globalThis, "__ro");
    return Array.isArray(ro) ? ro.length : 0;
  };
  await page.waitForFunction(reported, { timeout: 10_000 });
  await sleep(1000); // several 250 ms polls with nothing relaid out
  await page.setViewport({ width: 800, height: 300 });
  await page.waitForFunction(
    () => {
      const ro: unknown = Reflect.get(globalThis, "__ro");
      return Array.isArray(ro) && ro.length >= 2;
    },
    { timeout: 10_000 },
  );
  expect(await page.evaluate(() => Reflect.get(globalThis, "__ro"))).toEqual([300, 400]);
}, 60_000);

// A CSS animation leaves layout clean while it runs and only advances when something
// resolves, so a poll that skipped on a clean layout froze the observer mid-animation.
const growingBox = (css: string, script = "") => `<!doctype html><style>
  body { margin: 0 }
  @keyframes grow { from { width: 50px } to { width: 200px } }
  #box { height: 10px; ${css} }
</style><div id="box"></div><script>
  window.__ro = [];
  new ResizeObserver((entries) => {
    for (const entry of entries) window.__ro.push(Math.round(entry.contentRect.width));
  }).observe(document.getElementById("box"));
  ${script}
</script>`;

const growingCases: [string, string][] = [
  ["a @keyframes animation", growingBox("width: 200px; animation: grow 600ms linear")],
  [
    "a transition",
    growingBox(
      "width: 50px; transition: width 600ms linear",
      'setTimeout(() => { document.getElementById("box").style.width = "200px"; }, 300);',
    ),
  ],
];
for (const [name, markup] of growingCases) {
  test(`ResizeObserver reports the final size after ${name}`, async ({ page }) => {
    await page.setViewport({ width: 600, height: 300 });
    await setContent(page, markup);
    // Wait without touching the page: an evaluation in flight resolves layout itself,
    // which would advance the animation for the observer and hide the stall.
    await sleep(3000);
    const log = await page.evaluate(() => Reflect.get(globalThis, "__ro"));
    expect(Array.isArray(log) ? log[log.length - 1] : log).toBe(200);
  }, 60_000);
}

// clientTop/clientLeft are border offsets in the CSSOM geometry sum.
test("clientTop/clientLeft are the top/left border widths", async ({ page }) => {
  await page.setViewport({ width: 600, height: 300 });
  await setContent(page, html, { waitUntil: "domcontentloaded" });

  expect(
    await page.evaluate(() => {
      const byId = (id: string) => document.getElementById(id)!;
      const de = document.documentElement;
      return {
        box: [byId("box").clientTop, byId("box").clientLeft],
        asym: [byId("asym").clientTop, byId("asym").clientLeft],
        hidden: [byId("hidden").clientTop, byId("hidden").clientLeft],
        de: [de.clientTop, de.clientLeft],
        body: [document.body.clientTop, document.body.clientLeft],
      };
    }),
  ).toEqual({
    box: [5, 5],
    asym: [7, 3],
    hidden: [0, 0],
    de: [0, 0],
    body: [0, 0],
  });

  expect(
    await page.evaluate(() => {
      const rect = document.getElementById("asym")!.getBoundingClientRect();
      const de = document.documentElement;
      return {
        top: rect.top + window.pageYOffset - de.clientTop,
        left: rect.left + window.pageXOffset - de.clientLeft,
      };
    }),
  ).toEqual({ top: 110, left: 0 });
});
