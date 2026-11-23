// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Page.printToPDF lays out into the paper content box. Subsequent geometry reads must restore the
// screen viewport instead of reporting the paper width until the next paint.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const html = `<!doctype html>
<style>html, body { margin: 0; } #box { width: 100%; height: 20px; }</style>
<div id="box"></div>`;

test("geometry reads after Page.printToPDF use the screen viewport", async ({
  page,
  cdpSession,
}) => {
  await page.setViewport({ width: 1280, height: 720 });
  await setContent(page, html, { waitUntil: "domcontentloaded" });

  const widthBefore = await page.evaluate(
    () => document.getElementById("box")?.getBoundingClientRect().width ?? 0,
  );
  expect(widthBefore).toBe(1280);

  const pdf = await cdpSession.send("Page.printToPDF", {});
  expect(pdf.error).toBeUndefined();
  expect(typeof pdf.data).toBe("string");

  const widthAfter = await page.evaluate(
    () => document.getElementById("box")?.getBoundingClientRect().width ?? 0,
  );
  expect(widthAfter).toBe(1280);
}, 60_000);
