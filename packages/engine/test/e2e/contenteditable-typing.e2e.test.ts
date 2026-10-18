// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession, Page } from "@cloudflare/puppeteer";
import { expect } from "vitest";

import { test } from "./harness";
import { setContent } from "./set-content";

const PAGE = `<div id=ed contenteditable><p>ab</p></div>
<script>
  globalThis.__log = [];
  const ed = document.getElementById("ed");
  for (const t of ["keydown", "keypress", "beforeinput", "textInput", "input", "keyup"]) {
    ed.addEventListener(t, (e) => {
      let r = e.type;
      if (e.type === "beforeinput" || e.type === "input") r += " " + e.inputType + " " + JSON.stringify(e.data);
      if (e.type === "textInput") r += " " + JSON.stringify(e.data);
      if (e.type === "keypress") r += " " + e.key;
      __log.push(r);
    });
  }
  globalThis.__take = () => { const l = __log.slice(); __log.length = 0; return l; };
  globalThis.__caret = (offset) => {
    ed.focus();
    getSelection().collapse(ed.querySelector("p").firstChild, offset);
  };
</script>`;

async function devtoolsKey(s: CDPSession, key: string, code: string, vk: number, text?: string) {
  await s.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key,
    code,
    windowsVirtualKeyCode: vk,
  });
  if (text)
    await s.send("Input.dispatchKeyEvent", {
      type: "char",
      key,
      code,
      text,
      windowsVirtualKeyCode: vk,
    });
  await s.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
}

async function take(page: Page): Promise<{ log: string[]; html: string }> {
  return page.evaluate(() => {
    const g = globalThis as typeof globalThis & { __take: () => string[] };
    return { log: g.__take(), html: document.getElementById("ed")!.innerHTML };
  });
}

test("typing into a contenteditable fires Chrome's editing events and edits the DOM", async ({
  page,
}) => {
  await setContent(page, PAGE);
  const s = await page.target().createCDPSession();
  await page.evaluate(() =>
    (globalThis as typeof globalThis & { __caret: (n: number) => void }).__caret(1),
  );
  await take(page);

  await devtoolsKey(s, "x", "KeyX", 88, "x");
  expect(await take(page)).toEqual({
    log: [
      "keydown",
      "keypress x",
      'beforeinput insertText "x"',
      'textInput "x"',
      'input insertText "x"',
      "keyup",
    ],
    html: "<p>axb</p>",
  });

  await page.keyboard.type("y");
  expect(await take(page)).toEqual({
    log: [
      "keydown",
      "keypress y",
      'beforeinput insertText "y"',
      'textInput "y"',
      'input insertText "y"',
      "keyup",
    ],
    html: "<p>axyb</p>",
  });

  await devtoolsKey(s, "Backspace", "Backspace", 8);
  expect(await take(page)).toEqual({
    log: [
      "keydown",
      "beforeinput deleteContentBackward null",
      "input deleteContentBackward null",
      "keyup",
    ],
    html: "<p>axb</p>",
  });

  await devtoolsKey(s, "Enter", "Enter", 13, "\r");
  const enter = await take(page);
  expect(enter.log).toEqual([
    "keydown",
    "keypress Enter",
    "beforeinput insertParagraph null",
    'textInput "\\n"',
    "input insertParagraph null",
    "keyup",
  ]);
  expect(enter.html).toBe("<p>ax</p><p>b</p>");

  await page.evaluate(() => {
    const ed = document.getElementById("ed")!;
    getSelection()!.collapse(ed.querySelector("p")!.firstChild!, 2);
    ed.addEventListener(
      "beforeinput",
      (e) => {
        (globalThis as typeof globalThis & { __ranges: string }).__ranges = e
          .getTargetRanges()
          .map((r) => `${r.startContainer.nodeName}:${r.startOffset}-${r.endOffset}`)
          .join();
        e.preventDefault();
      },
      { once: true },
    );
  });
  await devtoolsKey(s, "Backspace", "Backspace", 8);
  expect(
    await page.evaluate(() => [
      (globalThis as typeof globalThis & { __ranges: string }).__ranges,
      document.getElementById("ed")!.innerHTML,
    ]),
  ).toEqual(["#text:1-2", "<p>ax</p><p>b</p>"]);
});

test("cancelling keydown, keypress, beforeinput or textInput stops the edit", async ({ page }) => {
  await setContent(page, PAGE);
  const s = await page.target().createCDPSession();
  await page.evaluate(() =>
    (globalThis as typeof globalThis & { __caret: (n: number) => void }).__caret(1),
  );
  for (const ev of ["keydown", "keypress", "beforeinput", "textInput"]) {
    await page.evaluate((type) => {
      document
        .getElementById("ed")!
        .addEventListener(type, (e) => e.preventDefault(), { once: true });
    }, ev);
    await take(page);
    await devtoolsKey(s, "q", "KeyQ", 81, "q");
    const got = await take(page);
    expect(got.html, `${ev} cancelled`).toBe("<p>ab</p>");
    expect(got.log, `${ev} cancelled`).not.toContain('input insertText "q"');
    if (ev === "keydown") expect(got.log).toEqual(["keydown", "keyup"]);
  }
});

test("an editor that renders its own text from textInput works", async ({ page }) => {
  await setContent(
    page,
    `<div id=ed contenteditable><span data-offset-key=k><br></span></div>
    <script>
      let model = "";
      const ed = document.getElementById("ed");
      ed.addEventListener("textInput", (e) => {
        e.preventDefault();
        model += e.data;
        ed.innerHTML = "<span data-offset-key=k>" + model + "</span>";
        getSelection().collapse(ed.firstChild.firstChild, model.length);
      });
      ed.addEventListener("keydown", (e) => {
        if (e.key !== "Backspace") return;
        e.preventDefault();
        model = model.slice(0, -1);
        ed.innerHTML = "<span data-offset-key=k>" + (model || "<br>") + "</span>";
      });
    </script>`,
  );
  await page.evaluate(() => document.getElementById("ed")!.focus());
  await page.keyboard.type("hello");
  await page.keyboard.press("Backspace");
  expect(await page.evaluate(() => document.getElementById("ed")!.innerHTML)).toBe(
    '<span data-offset-key="k">hell</span>',
  );
});

test("isContentEditable follows the nearest contenteditable state", async ({ page }) => {
  await setContent(
    page,
    `<div id=a contenteditable><p id=b>x<span id=c contenteditable=false>y</span></p></div><p id=d>z</p>`,
  );
  const got = await page.evaluate(() =>
    ["a", "b", "c", "d"].map(
      (id) => (document.getElementById(id) as HTMLElement).isContentEditable,
    ),
  );
  expect(got).toEqual([true, true, false, false]);
});
