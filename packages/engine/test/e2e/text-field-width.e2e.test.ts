// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// Noto Sans at 16px averages 9px a character and spans 55px: 20 characters give 9 * 20 + 55 - 9,
// plus the UA sheet's 2px padding and 1px border on each side.
test("a text field with no width is as wide as its size attribute", async ({ page }) => {
  await setContent(
    page,
    `<style>
      body { margin: 0; font: 16px sans-serif; }
    </style>
    <div><input id="default"></div>
    <div><input id="ten" size="10"></div>
    <div><input id="zero" size="0"></div>
    <div><input id="search" type="search" size=" +10px"></div>`,
  );

  await expect(
    page.evaluate(() =>
      Object.fromEntries(
        ["default", "ten", "zero", "search"].map((id) => [
          id,
          document.getElementById(id)!.getBoundingClientRect().width,
        ]),
      ),
    ),
  ).resolves.toEqual({ default: 232, ten: 142, zero: 232, search: 142 });
}, 120_000);

test("a size set after the first layout resizes the field", async ({ page }) => {
  await setContent(
    page,
    `<style>
      body { margin: 0; font: 16px sans-serif; }
    </style>
    <div><input id="late"></div>
    <div><input id="early" size="5"></div>
    <div style="width: 200px"><input id="boxed" size="60"></div>`,
  );

  await expect(
    page.evaluate(() => {
      const late = document.getElementById("late") as HTMLInputElement;
      const width = (id: string): number =>
        document.getElementById(id)!.getBoundingClientRect().width;
      const before = width("late");
      late.size = 5;
      const resized = width("late");
      late.removeAttribute("size");
      return { before, resized, early: width("early"), restored: width("late") };
    }),
  ).resolves.toEqual({ before: 232, resized: 97, early: 97, restored: 232 });

  // A field wider than its container shrinks to it with its padding and border inside: sized
  // against the container's border box it came out 6px too wide.
  await expect(
    page.evaluate(() => document.getElementById("boxed")!.getBoundingClientRect().width),
  ).resolves.toBe(200);
}, 120_000);
