// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession, Page } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const FIELDS = `<input id=inp><textarea id=ta></textarea><div id=ce contenteditable>x</div>
<script>
  globalThis.__log = [];
  for (const id of ["inp", "ta", "ce"]) {
    const el = document.getElementById(id);
    for (const t of ["keydown", "keypress", "beforeinput", "textInput", "input", "keyup"]) {
      el.addEventListener(t, (e) => {
        let r = id + ":" + e.type;
        if (e.inputType !== undefined) r += " " + e.inputType;
        if (e.data !== undefined) r += " " + JSON.stringify(e.data);
        __log.push(r);
      });
    }
  }
  globalThis.__take = () => __log.splice(0);
</script>`;

type FieldId = "inp" | "ta" | "ce";

async function focusField(page: Page, id: FieldId): Promise<void> {
  await page.evaluate((fieldId: string) => {
    const el = document.getElementById(fieldId)!;
    el.focus();
    if (fieldId === "ce") getSelection()!.collapse(el.firstChild!, 1);
    (globalThis as typeof globalThis & { __take: () => string[] }).__take();
  }, id);
}

async function read(page: Page, id: FieldId): Promise<{ value: string; log: string[] }> {
  return page.evaluate((fieldId: string) => {
    const el = document.getElementById(fieldId) as HTMLInputElement;
    const log = (globalThis as typeof globalThis & { __take: () => string[] }).__take();
    return { value: fieldId === "ce" ? el.innerHTML : el.value, log };
  }, id);
}

async function enter(s: CDPSession): Promise<void> {
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  await s.send("Input.dispatchKeyEvent", { type: "keyDown", ...key, text: "\r" });
  await s.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

test("Input.insertText keeps line breaks and tabs as Chrome does", async ({ page, cdpSession }) => {
  await setContent(page, FIELDS);
  const cases: Array<[FieldId, string, string]> = [
    ["ta", "a\nb", "a\nb"],
    ["ta", "a\r\nb\rc", "a\nb\nc"],
    ["ta", "a\tb", "a\tb"],
    ["inp", "a\nb", "a b"],
    ["inp", "a\r\nb\n\n", "a b"],
    ["inp", "a\tb", "a\tb"],
  ];
  for (const [id, text, expected] of cases) {
    await page.evaluate((fieldId: string) => {
      (document.getElementById(fieldId) as HTMLInputElement).value = "";
    }, id);
    await focusField(page, id);
    await cdpSession.send("Input.insertText", { text });
    expect((await read(page, id)).value, `${id} ${JSON.stringify(text)}`).toBe(expected);
  }

  await focusField(page, "ce");
  await cdpSession.send("Input.insertText", { text: "a\nb" });
  const ce = await page.evaluate(() => {
    const el = document.getElementById("ce")!;
    return { text: el.textContent, lastLine: el.lastElementChild?.outerHTML };
  });
  expect(ce).toEqual({ text: "xab", lastLine: "<div>b</div>" });
});

test("Input.insertText is an insertion with no key events", async ({ page, cdpSession }) => {
  await setContent(page, FIELDS);
  await page.evaluate(() =>
    document.getElementById("ta")!.addEventListener("keydown", (e) => e.preventDefault()),
  );
  await focusField(page, "ta");
  await cdpSession.send("Input.insertText", { text: "hi\nthere" });
  const got = await read(page, "ta");
  expect(got.value).toBe("hi\nthere");
  expect(got.log.filter((entry) => /key/.test(entry))).toEqual([]);
  expect(got.log).toContain("ta:input");
});

test("Enter breaks a line in a textarea and leaves a single-line field alone", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, FIELDS);
  await focusField(page, "ta");
  await cdpSession.send("Input.insertText", { text: "ab" });
  await page.evaluate(() =>
    (document.getElementById("ta") as HTMLTextAreaElement).setSelectionRange(1, 1),
  );
  await enter(cdpSession);
  expect((await read(page, "ta")).value).toBe("a\nb");
  expect(
    await page.evaluate(
      () => (document.getElementById("ta") as HTMLTextAreaElement).selectionStart,
    ),
  ).toBe(2);

  await focusField(page, "inp");
  await cdpSession.send("Input.insertText", { text: "ab" });
  await enter(cdpSession);
  expect((await read(page, "inp")).value).toBe("ab");
});

test("Tab moves focus and its tab character lands in no field", async ({ page, cdpSession }) => {
  await setContent(page, FIELDS);
  await focusField(page, "inp");
  const tab = { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 };
  await cdpSession.send("Input.dispatchKeyEvent", { type: "keyDown", ...tab, text: "\t" });
  await cdpSession.send("Input.dispatchKeyEvent", { type: "keyUp", ...tab });
  await cdpSession.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...tab });
  await cdpSession.send("Input.dispatchKeyEvent", { type: "char", ...tab, text: "\t" });
  await cdpSession.send("Input.dispatchKeyEvent", { type: "keyUp", ...tab });
  expect(
    await page.evaluate(() => [
      document.activeElement?.id,
      (document.getElementById("inp") as HTMLInputElement).value,
      (document.getElementById("ta") as HTMLTextAreaElement).value,
      document.getElementById("ce")!.textContent,
    ]),
  ).toEqual(["ce", "", "", "x"]);
});

test("a readonly field and a checkbox take no typed text", async ({ page, cdpSession }) => {
  await setContent(page, `<input id=ro readonly value=keep><input id=cb type=checkbox>`);
  for (const id of ["ro", "cb"]) {
    await page.focus(`#${id}`);
    await cdpSession.send("Input.insertText", { text: "x" });
    await cdpSession.send("Input.dispatchKeyEvent", { type: "keyDown", key: "y", text: "y" });
    await cdpSession.send("Input.dispatchKeyEvent", { type: "keyUp", key: "y" });
  }
  expect(
    await page.evaluate(() =>
      ["ro", "cb"].map((id) => (document.getElementById(id) as HTMLInputElement).value),
    ),
  ).toEqual(["keep", "on"]);
});
