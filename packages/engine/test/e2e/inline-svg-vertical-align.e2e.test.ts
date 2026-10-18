// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { setContent } from "./set-content";
import { expect, test } from "./harness";

test("inline SVG honors vertical-align: middle", async ({ page }) => {
  await setContent(
    page,
    `<style>
      body { margin: 0; font: 20px/28px sans-serif; }
      .row { margin: 20px; }
      svg { width: 16px; height: 16px; }
      .middle { vertical-align: middle; }
      .baseline { vertical-align: baseline; }
      .large { font-size: 40px; }
      .nested-parent { font-size: 40px; }
    </style>
    <div id=text class=row>text <svg id=text-middle class=middle viewBox="0 0 16 16"></svg><svg id=text-baseline class=baseline viewBox="0 0 16 16"></svg></div>
    <div id=icon class=row><svg id=icon-middle class=middle viewBox="0 0 16 16"></svg><svg id=icon-baseline class=baseline viewBox="0 0 16 16"></svg></div>
    <div id=mixed class=row><span class=large>large</span><svg id=mixed-middle class=middle viewBox="0 0 16 16"></svg><svg id=mixed-baseline class=baseline viewBox="0 0 16 16"></svg></div>
    <div id=nested class=row><span class=nested-parent><svg id=nested-middle class=middle viewBox="0 0 16 16"></svg><svg id=nested-baseline class=baseline viewBox="0 0 16 16"></svg></span></div>`,
  );

  const shift = await page.evaluate(() => {
    const middleMinusBaseline = (name: string) => {
      const middle = document.querySelector(`#${name}-middle`)!.getBoundingClientRect();
      const baseline = document.querySelector(`#${name}-baseline`)!.getBoundingClientRect();
      return middle.top - baseline.top;
    };
    return {
      text: middleMinusBaseline("text"),
      icon: middleMinusBaseline("icon"),
      mixed: middleMinusBaseline("mixed"),
      nested: middleMinusBaseline("nested"),
    };
  });

  expect(shift.text).toBeGreaterThan(0);
  expect(Math.abs(shift.text - shift.icon)).toBeLessThan(0.5);
  expect(Math.abs(shift.text - shift.mixed)).toBeLessThan(0.5);
  expect(Math.abs(shift.nested - shift.text)).toBeGreaterThan(0.5);
});

test("inline SVG middle alignment uses an intervening font family", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/font-face.html", {
    waitUntil: "load",
    timeout: 30_000,
  });
  await page.evaluate(() => document.fonts.ready);

  const shifts = await page.evaluate(() => {
    const svg = "http://www.w3.org/2000/svg";
    const middleMinusBaseline = (fontFamily: string) => {
      const row = document.createElement("div");
      const parent = document.createElement("span");
      parent.style.cssText = `font: 100px/120px ${fontFamily};`;
      const makeIcon = (verticalAlign: string) => {
        const icon = document.createElementNS(svg, "svg");
        icon.setAttribute("viewBox", "0 0 16 16");
        icon.style.cssText = `width: 16px; height: 16px; vertical-align: ${verticalAlign};`;
        return icon;
      };
      const middle = makeIcon("middle");
      const baseline = makeIcon("baseline");
      parent.append(middle, baseline);
      row.append(parent);
      document.body.append(row);
      return middle.getBoundingClientRect().top - baseline.getBoundingClientRect().top;
    };

    return {
      serif: middleMinusBaseline("serif"),
      bungee: middleMinusBaseline('"Bungee"'),
    };
  });

  expect(
    Math.abs(shifts.serif - shifts.bungee),
    `font-family should change the middle shift: ${JSON.stringify(shifts)}`,
  ).toBeGreaterThan(0.5);
});
