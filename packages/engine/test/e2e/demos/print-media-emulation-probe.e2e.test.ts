// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("print-media-emulation-probe", async ({ page }) => {
  const HTML = `<!doctype html>
<html><head>
<style>
  @page { size: A4 landscape; margin: 1in }
  body { color: black; font-family: sans-serif; margin: 0; padding: 1em }
  @media print {
    body { color: red }
  }
</style>
</head><body>
<p id="t">Print-media end-to-end probe.</p>
</body></html>`;
  const url = "data:text/html;base64," + Buffer.from(HTML).toString("base64");

  function readMediaBox(bytes) {
    const s = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 50000)));
    const m = s.match(/\/MediaBox\s*\[\s*([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s+([\d.+-]+)\s*\]/);
    if (!m) return null;
    return {
      x0: parseFloat(m[1]),
      y0: parseFloat(m[2]),
      x1: parseFloat(m[3]),
      y1: parseFloat(m[4]),
      width: parseFloat(m[3]) - parseFloat(m[1]),
      height: parseFloat(m[4]) - parseFloat(m[2]),
    };
  }

  const session = await page.target().createCDPSession();
  await page.goto(url, { timeout: 30000, waitUntil: "load" });

  const colorScreen = await page.evaluate(() => getComputedStyle(document.body).color);

  await session.send("Emulation.setEmulatedMedia", { media: "print" });
  const colorPrint = await page.evaluate(() => getComputedStyle(document.body).color);

  await session.send("Emulation.setEmulatedMedia", { media: "" });
  const colorRestored = await page.evaluate(() => getComputedStyle(document.body).color);

  expect(colorScreen, "@media screen body color (black)").toContain("0, 0, 0");
  expect(colorPrint, "@media print body color (red)").toContain("255, 0, 0");
  expect(colorRestored, "restored color == screen color").toBe(colorScreen);

  const pdf = await session.send("Page.printToPDF", {
    paperWidth: 8.5,
    paperHeight: 11,
    landscape: false,
    preferCSSPageSize: true,
  });
  expect(
    typeof pdf.data === "string" && pdf.data.length > 0,
    "Page.printToPDF returned data",
  ).toBeTruthy();

  const bytes = Buffer.from(pdf.data, "base64");
  const mb = readMediaBox(bytes);
  expect(mb, "PDF MediaBox extracted").toBeTruthy();

  console.log(`  MediaBox: ${mb.width.toFixed(1)} × ${mb.height.toFixed(1)} units`);
  const aspect = mb.width / mb.height;
  expect(aspect, "PDF aspect ratio matches A4 landscape (≈1.414)").toBeCloseTo(Math.SQRT2, 2);
  expect(mb.width, "PDF is wider than tall (landscape, not portrait Letter)").toBeGreaterThan(
    mb.height,
  );
});
