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
  expect(await read(page, "ta")).toEqual({
    value: "hi\nthere",
    log: [
      'ta:beforeinput insertText "hi\\nthere"',
      'ta:textInput "hi\\nthere"',
      'ta:input insertText "hi\\nthere"',
    ],
  });
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

async function key(s: CDPSession, k: string, code: string, vk: number, text = ""): Promise<void> {
  await s.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: k,
    code,
    windowsVirtualKeyCode: vk,
    text,
  });
  await s.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: k,
    code,
    windowsVirtualKeyCode: vk,
  });
}

test("typing fires Chrome's keypress, beforeinput, textInput and InputEvent", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, FIELDS);
  for (const id of ["inp", "ta"] as const) {
    await focusField(page, id);
    await key(cdpSession, "a", "KeyA", 65, "a");
    expect((await read(page, id)).log, `${id} a`).toEqual([
      `${id}:keydown`,
      `${id}:keypress`,
      `${id}:beforeinput insertText "a"`,
      `${id}:textInput "a"`,
      `${id}:input insertText "a"`,
      `${id}:keyup`,
    ]);
    await key(cdpSession, "Backspace", "Backspace", 8);
    expect((await read(page, id)).log, `${id} Backspace`).toEqual([
      `${id}:keydown`,
      `${id}:beforeinput deleteContentBackward null`,
      `${id}:input deleteContentBackward null`,
      `${id}:keyup`,
    ]);
  }

  await key(cdpSession, "Enter", "Enter", 13, "\r");
  expect(await read(page, "ta")).toEqual({
    value: "\n",
    log: [
      "ta:keydown",
      "ta:keypress",
      "ta:beforeinput insertLineBreak null",
      'ta:textInput "\\n"',
      "ta:input insertLineBreak null",
      "ta:keyup",
    ],
  });

  await focusField(page, "inp");
  await key(cdpSession, "Enter", "Enter", 13, "\r");
  expect(await read(page, "inp")).toEqual({
    value: "",
    log: ["inp:keydown", "inp:keypress", "inp:beforeinput insertLineBreak null", "inp:keyup"],
  });

  await cdpSession.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "b", code: "KeyB" });
  await cdpSession.send("Input.dispatchKeyEvent", { type: "char", key: "b", text: "b" });
  await cdpSession.send("Input.dispatchKeyEvent", { type: "keyUp", key: "b", code: "KeyB" });
  expect((await read(page, "inp")).log).toEqual([
    "inp:keydown",
    "inp:keypress",
    'inp:beforeinput insertText "b"',
    'inp:textInput "b"',
    'inp:input insertText "b"',
    "inp:keyup",
  ]);

  await page.evaluate(() => {
    document.getElementById("inp")!.addEventListener("keypress", (e) => {
      document.title = [e.keyCode, e.charCode, e.which].join(" ");
    });
  });
  await key(cdpSession, "a", "KeyA", 65, "a");
  expect(await page.title(), "a keypress's legacy codes are the character's").toBe("97 97 97");
});

test("cancelling keypress, beforeinput or textInput stops the entry", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, FIELDS);
  for (const id of ["inp", "ta"] as const) {
    for (const type of ["keypress", "beforeinput", "textInput"]) {
      await page.evaluate(
        (fieldId: string, eventType: string) =>
          document
            .getElementById(fieldId)!
            .addEventListener(eventType, (e) => e.preventDefault(), { once: true }),
        id,
        type,
      );
      await focusField(page, id);
      await key(cdpSession, "q", "KeyQ", 81, "q");
      const got = await read(page, id);
      expect(got.value, `${id} ${type}`).toBe("");
      expect(got.log, `${id} ${type}`).not.toContain(`${id}:input insertText "q"`);
    }
  }
});

// A search box whose keypress handler runs the search and cancels Enter: Chrome submits nothing,
// while a submit on keydown reloaded the page before the handler could run.
test("Enter submits as keypress's default action", async ({ page, cdpSession }) => {
  await setContent(
    page,
    `<form id=f action="/search"><input id=q name=q></form>
    <script>
      globalThis.__seen = [];
      const q = document.getElementById("q");
      document.getElementById("f").addEventListener("submit", (e) => {
        e.preventDefault();
        __seen.push("submit");
      });
      q.addEventListener("keypress", (e) => {
        __seen.push("keypress " + e.key);
        if (e.key === "Enter" && q.dataset.cancel === "keypress") e.preventDefault();
      });
      q.addEventListener("beforeinput", (e) => {
        if (e.inputType === "insertLineBreak" && q.dataset.cancel === "beforeinput") e.preventDefault();
      });
    </script>`,
  );
  const pressEnter = async (cancel: string): Promise<string[]> => {
    await page.evaluate((how: string) => {
      const q = document.getElementById("q") as HTMLInputElement;
      q.dataset.cancel = how;
      q.focus();
      (globalThis as typeof globalThis & { __seen: string[] }).__seen = [];
    }, cancel);
    await key(cdpSession, "Enter", "Enter", 13, "\r");
    return page.evaluate(() => (globalThis as typeof globalThis & { __seen: string[] }).__seen);
  };
  expect(await pressEnter("")).toEqual(["keypress Enter", "submit"]);
  expect(await pressEnter("keypress")).toEqual(["keypress Enter"]);
  expect(await pressEnter("beforeinput")).toEqual(["keypress Enter"]);
});

const FORMS = `<form id=contact><label>Name</label><input id=name><label>Email</label><input id=email type=email>
  <textarea>msg</textarea><button type=button>Send</button><input type=checkbox checked></form>
<form id=one><input id=q></form>
<form id=withButton><input id=from><input id=to><button id=go>Go</button></form>
<form id=disabledButton><input id=d1><input id=d2><button disabled>Off</button></form>
<form id=cancelled><input id=c1><input id=c2><button id=stop>Stop</button></form>
<form id=named><input id=e1 name=elements><input id=e2></form>
<script>
  globalThis.__seen = [];
  for (const f of document.forms) {
    f.addEventListener("submit", (e) => {
      e.preventDefault();
      __seen.push("submit " + f.id + " " + (e.submitter ? e.submitter.id : "null"));
    });
  }
  for (const b of document.querySelectorAll("button")) {
    b.addEventListener("click", (e) => __seen.push("click " + b.id + " " + e.isTrusted));
  }
  document.getElementById("stop").addEventListener("click", (e) => e.preventDefault());
</script>`;

test("Enter submits a form only with a submit button or a single text field", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, FORMS);
  const enterIn = async (id: string): Promise<string[]> => {
    await page.evaluate((fieldId: string) => {
      document.getElementById(fieldId)!.focus();
      (globalThis as typeof globalThis & { __seen: string[] }).__seen = [];
    }, id);
    await key(cdpSession, "Enter", "Enter", 13, "\r");
    return page.evaluate(() => (globalThis as typeof globalThis & { __seen: string[] }).__seen);
  };
  expect(await enterIn("name"), "several fields, no submit button").toEqual([]);
  expect(await enterIn("e2"), "several fields, one named elements").toEqual([]);
  expect(await enterIn("q"), "a single field").toEqual(["submit one null"]);
  expect(await enterIn("from"), "a submit button").toEqual([
    "click go true",
    "submit withButton go",
  ]);
  expect(await enterIn("d1"), "a disabled default button").toEqual([]);
  expect(await enterIn("c1"), "a cancelled default button click").toEqual(["click stop true"]);
});
// A field inherits isContentEditable from an editable ancestor, so the region was asked first
// and took the text, the Backspace and the Enter that belonged to the field.
test("a field inside an editable region takes its own text", async ({ page, cdpSession }) => {
  await setContent(page, `<div id=region contenteditable>x<input id=inner value=ab></div>`);
  await page.evaluate(() => {
    const inner = document.getElementById("inner") as HTMLInputElement;
    inner.focus();
    inner.setSelectionRange(2, 2);
  });
  await key(cdpSession, "c", "KeyC", 67, "c");
  await cdpSession.send("Input.insertText", { text: "de" });
  await key(cdpSession, "Backspace", "Backspace", 8);
  await key(cdpSession, "Enter", "Enter", 13, "\r");
  const seen = await page.evaluate(() => ({
    value: (document.getElementById("inner") as HTMLInputElement).value,
    region: document.getElementById("region")!.textContent,
    paragraphs: document.querySelectorAll("#region div, #region br").length,
  }));
  expect(seen).toEqual({ value: "abcd", region: "x", paragraphs: 0 });
});
