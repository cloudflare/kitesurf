// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";
import { decodePng } from "./png";

function pixel(png: ReturnType<typeof decodePng>, index: number): number {
  return png.pixels[index] ?? 0;
}

function isCaretPixel(png: ReturnType<typeof decodePng>, index: number): boolean {
  return pixel(png, index) > 200 && pixel(png, index + 1) < 160 && pixel(png, index + 2) < 160;
}

function caretColumns(
  png: ReturnType<typeof decodePng>,
  rect: { top: number; bottom: number },
): number[] {
  const columns: number[] = [];
  for (let x = 0; x < png.width; x++) {
    let redPixels = 0;
    for (let y = Math.floor(rect.top); y < Math.ceil(rect.bottom); y++) {
      const i = (y * png.width + x) * 4;
      redPixels += Number(isCaretPixel(png, i));
    }
    if (redPixels >= 12) columns.push(x);
  }
  return columns;
}

test("textarea caret uses the computed font family", async ({ page }) => {
  const value = "<html> adfasdfasdfas </html>";
  const measureText = value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  await setContent(
    page,
    `<!doctype html><style>
    html, body { margin: 0; background: #ffffff; }
    #measure, #editor { position: absolute; left: 20px; top: 20px;
      padding: 0; border: 0; font: 16px/24px monospace; white-space: pre; }
    #measure { display: inline-block; width: max-content; visibility: hidden; }
    #editor { width: 400px; height: 40px; color: transparent;
      caret-color: rgb(255, 0, 0); background: #ffffff; }
  </style><span id="measure">${measureText}</span><textarea id="editor"></textarea>`,
  );
  await new Promise((resolve) => setTimeout(resolve, 250));

  await page.click("#editor");
  await page.keyboard.type(value);
  await new Promise((resolve) => setTimeout(resolve, 150));

  const rect = await page.$eval("#editor", (element) => {
    const r = element.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  const expected = await page.$eval("#measure", (element) => element.getBoundingClientRect().right);
  const screenshot = await page.screenshot({ type: "png" });
  const png = decodePng(screenshot);
  const columns = caretColumns(png, rect);
  expect(
    columns.some((x) => Math.abs(x - expected) <= 2),
    `caret columns ${columns.join(",")} must end at ${expected}`,
  ).toBe(true);
}, 120_000);
