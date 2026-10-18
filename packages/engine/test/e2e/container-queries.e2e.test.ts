// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("container shorthand and size queries use the laid-out container", async ({ page }) => {
  await setContent(
    page,
    `<style>
      .container { container: probe / inline-size; width: 800px; }
      @container probe (width > 730px) {
        .target { padding-left: 12rem; color: red; }
      }
    </style>
    <div class="container"><div class="target">probe</div></div>`,
  );

  await expect(
    page.evaluate(() => {
      const container = document.querySelector<HTMLElement>(".container")!;
      const target = document.querySelector<HTMLElement>(".target")!;
      const containerStyle = getComputedStyle(container);
      const targetStyle = getComputedStyle(target);
      return {
        containerType: containerStyle.containerType,
        containerName: containerStyle.containerName,
        paddingLeft: targetStyle.paddingLeft,
        color: targetStyle.color,
      };
    }),
  ).resolves.toEqual({
    containerType: "inline-size",
    containerName: "probe",
    paddingLeft: "192px",
    color: "rgb(255, 0, 0)",
  });
}, 120_000);

test("a query inside a resized container sees the size the outer query gave it", async ({
  page,
}) => {
  await setContent(
    page,
    `<style>
      .outer { container-type: inline-size; width: 800px; }
      .inner { container-type: inline-size; width: 50%; }
      @container (width > 700px) { .inner { width: 25%; } }
      @container (width < 300px) { .leaf { padding-left: 7px; color: rgb(0, 128, 0); } }
    </style>
    <div class="outer"><div class="inner"><div class="leaf">leaf</div></div></div>`,
  );

  await expect(
    page.evaluate(() => {
      const inner = document.querySelector<HTMLElement>(".inner")!;
      const leafStyle = getComputedStyle(document.querySelector<HTMLElement>(".leaf")!);
      return {
        innerWidth: inner.getBoundingClientRect().width,
        paddingLeft: leafStyle.paddingLeft,
        color: leafStyle.color,
      };
    }),
  ).resolves.toEqual({
    innerWidth: 200,
    paddingLeft: "7px",
    color: "rgb(0, 128, 0)",
  });
}, 120_000);
