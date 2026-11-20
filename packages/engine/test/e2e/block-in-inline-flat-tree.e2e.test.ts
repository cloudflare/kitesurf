// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// A block inside inline boxes is laid out against the nearest block container, whether the
// inlines are shadow hosts, slots, display: contents boxes or plain spans.

test("blocks inside nested inline shadow hosts fill the containing block", async ({ page }) => {
  await setContent(page, `<div style="width: 600px"><x-host></x-host></div>`);
  const widths = await page.evaluate(() => {
    const host = document.querySelector("x-host")!;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = "<x-child></x-child>";
    const nested = root.firstElementChild!.attachShadow({ mode: "open" });
    nested.innerHTML = "<div>inside</div>";
    return [host, root.firstElementChild!, nested.firstElementChild!].map(
      (element) => element.getBoundingClientRect().width,
    );
  });
  expect(widths).toEqual([600, 600, 600]);
});

test("slotted blocks break the inline flow through a shadow wrapper", async ({ page }) => {
  await setContent(page, `<div style="width: 600px"><x-host><div>inside</div></x-host></div>`);
  const widths = await page.evaluate(() => {
    const host = document.querySelector("x-host")!;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = "<span><slot></slot></span>";
    return [host, root.firstElementChild!, host.firstElementChild!].map(
      (element) => element.getBoundingClientRect().width,
    );
  });
  expect(widths).toEqual([600, 600, 600]);
});

test("a block behind a display: contents box breaks its inline parent's flow", async ({ page }) => {
  await setContent(
    page,
    `<div style="width: 600px"><span id="inline"><x-contents style="display: contents"
      ><div id="block">inside</div></x-contents></span></div>`,
  );
  const widths = await page.evaluate(() =>
    ["inline", "block"].map((id) => document.getElementById(id)!.getBoundingClientRect().width),
  );
  expect(widths).toEqual([600, 600]);
});

for (const [wrapperDisplay, childHeight, expectedHeight] of [
  ["inline", "100%", 120],
  ["inline", "auto", 40],
  ["block", "100%", 40],
  ["inline-block", "100%", 40],
] as const) {
  test(`percentage heights cross inline shadow hosts: ${wrapperDisplay}, ${childHeight}`, async ({
    page,
  }) => {
    await setContent(page, `<div style="height: 120px; width: 600px"><x-host></x-host></div>`);
    const height = await page.evaluate(
      (display, height) => {
        const root = document.querySelector("x-host")!.attachShadow({ mode: "open" });
        root.innerHTML = `<x-child style="display: ${display}"></x-child>`;
        const nested = root.firstElementChild!.attachShadow({ mode: "open" });
        nested.innerHTML = `<div style="height: ${height}"><div style="height: 40px"></div></div>`;
        return nested.firstElementChild!.getBoundingClientRect().height;
      },
      wrapperDisplay,
      childHeight,
    );
    expect(height).toBe(expectedHeight);
  });
}

test("a percentage height inside nested spans resolves against the block container", async ({
  page,
}) => {
  await setContent(
    page,
    `<div style="height: 120px"><span><span><div id="target" style="height: 50%"></div></span></span></div>`,
  );
  const height = await page.evaluate(
    () => document.getElementById("target")!.getBoundingClientRect().height,
  );
  expect(height).toBe(60);
});

test("a span blockified as a flex item does not pass the container's height down", async ({
  page,
}) => {
  await setContent(
    page,
    `<div style="display: flex; align-items: flex-start; height: 120px; width: 600px"><span
      ><div id="target" style="height: 100%"><div style="height: 40px"></div></div></span></div>`,
  );
  const height = await page.evaluate(
    () => document.getElementById("target")!.getBoundingClientRect().height,
  );
  // The unstretched flex item has an auto height, so 100% behaves as auto.
  expect(height).toBe(40);
});
