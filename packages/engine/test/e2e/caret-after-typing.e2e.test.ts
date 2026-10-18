// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("typing leaves the painted caret at the end of the value", async ({ page, cdpSession }) => {
  await page.setViewport({ width: 400, height: 120 });
  await setContent(
    page,
    `<style>body { margin: 0 } #c { font: 16px monospace; width: 300px }</style>
     <input id="c" type="text" />`,
    { waitUntil: "domcontentloaded" },
  );

  const frame = async (): Promise<string> => {
    const shot = (await cdpSession.send("Page.captureScreenshot", {
      format: "png",
    })) as { data: string };
    return shot.data;
  };
  const setCaret = (at: number) =>
    page.evaluate((n: number) => {
      (document.querySelector("#c") as HTMLInputElement).setSelectionRange(n, n);
    }, at);

  await page.evaluate(() => (document.querySelector("#c") as HTMLInputElement).focus());
  for (const ch of "abcd") {
    await cdpSession.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch });
    await cdpSession.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
  }
  const typed = await frame();
  expect(
    await page.evaluate(() => {
      const i = document.querySelector("#c") as HTMLInputElement;
      return [i.value, i.selectionStart, i.selectionEnd];
    }),
  ).toEqual(["abcd", 4, 4]);

  await setCaret(4);
  expect(await frame()).toBe(typed);

  await setCaret(3);
  expect(await frame()).not.toBe(typed);

  await page.evaluate(() => {
    (document.querySelector("#c") as HTMLInputElement).value = "abcdef";
  });
  const written = await frame();
  await setCaret(6);
  expect(await frame()).toBe(written);
  await setCaret(5);
  expect(await frame()).not.toBe(written);
}, 120_000);
