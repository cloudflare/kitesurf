// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const PAGE = `<!doctype html><html><body><svg width="200" height="200">
  <circle id="circle" cx="50" cy="50" r="20"></circle>
  <ellipse id="ellipse" cx="50" cy="50" rx="30" ry="30"></ellipse>
  <line id="line" x1="0" y1="0" x2="3" y2="4"></line>
  <rect id="rect" x="0" y="0" width="10" height="20"></rect>
  <polyline id="polyline" points="0,0 3,4 3,10"></polyline>
  <polygon id="polygon" points="0,0 3,0 3,4"></polygon>
  <path id="path" d="M0 0 L10 0"></path>
</svg></body></html>`;

test("getTotalLength measures the basic SVG shapes", async ({ page }) => {
  await page.goto("data:text/html," + encodeURIComponent(PAGE), {
    waitUntil: "domcontentloaded",
  });

  const lengths = await page.evaluate(() => {
    // PAGE contains each of these IDs as an SVG geometry element.
    const of = (id: string) =>
      (document.querySelector<SVGGeometryElement>(`#${id}`) as SVGGeometryElement).getTotalLength();
    return {
      circle: of("circle"),
      ellipse: of("ellipse"),
      line: of("line"),
      rect: of("rect"),
      polyline: of("polyline"),
      polygon: of("polygon"),
      path: of("path"),
      htmlThrows: (() => {
        try {
          // The shim installs this on Element and rejects non-SVG receivers.
          (
            document.body as HTMLElement & Pick<SVGGeometryElement, "getTotalLength">
          ).getTotalLength();
          return false;
        } catch {
          return true;
        }
      })(),
    };
  });

  expect(lengths.circle).toBeCloseTo(2 * Math.PI * 20, 6);
  expect(lengths.ellipse).toBeCloseTo(2 * Math.PI * 30, 6);
  expect(lengths.line).toBeCloseTo(5, 6);
  expect(lengths.rect).toBeCloseTo(60, 6);
  expect(lengths.polyline).toBeCloseTo(11, 6);
  expect(lengths.polygon).toBeCloseTo(12, 6);
  expect(lengths.path).toBe(0);
  expect(lengths.htmlThrows).toBe(true);
});
