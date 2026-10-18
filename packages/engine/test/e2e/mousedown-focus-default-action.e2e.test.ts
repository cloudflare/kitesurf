// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

interface Probe {
  log: string[];
  active: string;
}

test("mousedown focus runs post-dispatch and honours preventDefault", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/events.html", {
    waitUntil: "domcontentloaded",
  });
  const session = await page.createCDPSession();

  await page.evaluate(() => {
    const w = globalThis as typeof globalThis & { __ks_log: string[] };
    document.body.innerHTML = `
      <input id="i" value="typed">
      <div id="plain" style="width:200px;height:60px">plain</div>
      <div id="prevented" style="width:200px;height:60px">prevented</div>
      <button id="btn" style="width:200px;height:40px">button</button>`;
    w.__ks_log = [];
    const rec = (label: string) =>
      w.__ks_log.push(`${label}:${document.activeElement?.id || "body"}`);
    for (const id of ["plain", "prevented", "btn"]) {
      const el = document.getElementById(id)!;
      el.addEventListener("mousedown", (e) => {
        rec(`mousedown@${id}`);
        if (id === "prevented") e.preventDefault();
      });
      el.addEventListener("mouseup", () => rec(`mouseup@${id}`));
    }
  });

  const clickCentre = async (selector: string): Promise<Probe> => {
    const p = await page.evaluate((s: string) => {
      const w = globalThis as typeof globalThis & { __ks_log: string[] };
      w.__ks_log = [];
      (document.querySelector("#i") as HTMLInputElement).focus();
      const r = document.querySelector(s)!.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }, selector);
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await session.send("Input.dispatchMouseEvent", {
        type,
        x: p.x,
        y: p.y,
        button: "left",
        clickCount: 1,
      });
    }
    return page.evaluate(() => {
      const w = globalThis as typeof globalThis & { __ks_log: string[] };
      return { log: w.__ks_log.slice(), active: document.activeElement?.id || "body" };
    });
  };

  const plain = await clickCentre("#plain");
  expect(plain.log).toEqual(["mousedown@plain:i", "mouseup@plain:body"]);
  expect(plain.active).toBe("body");

  const prevented = await clickCentre("#prevented");
  expect(prevented.log).toEqual(["mousedown@prevented:i", "mouseup@prevented:i"]);
  expect(prevented.active).toBe("i");

  const button = await clickCentre("#btn");
  expect(button.log).toEqual(["mousedown@btn:i", "mouseup@btn:btn"]);
  expect(button.active).toBe("btn");
}, 120_000);

test("mouseup form submissions follow the mouseup navigation", async ({
  page,
  cdpSession: session,
}) => {
  let formNavigations = 0;
  session.on("Page.frameNavigated", ({ frame }: { frame: { url: string } }) => {
    if (frame.url.startsWith("https://ks.invalid/__fixtures/form-echo")) {
      formNavigations++;
    }
  });
  for (const scenario of [
    { method: "get", submit: "submit", expectedBody: "", expectedQuery: "?user=rui" },
    { method: "post", submit: "requestSubmit", expectedBody: "user=rui", expectedQuery: "" },
  ]) {
    await setContent(
      page,
      `<form id="f" method="${scenario.method}" action="https://ks.invalid/__fixtures/form-echo">
        <input name="user" value="rui">
        <button id="submit" type="submit">submit</button>
      </form>`,
    );
    const point = await page.$eval("#submit", (el) => {
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    await page.evaluate((submit: string) => {
      const form = document.getElementById("f") as HTMLFormElement;
      document.getElementById("submit")!.addEventListener("mouseup", () => {
        if (submit === "requestSubmit") form.requestSubmit();
        else form.submit();
      });
    }, scenario.submit);

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10_000 }),
      (async () => {
        await session.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: point.x,
          y: point.y,
          button: "left",
          clickCount: 1,
        });
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: point.x,
          y: point.y,
          button: "left",
          clickCount: 1,
        });
      })(),
    ]);

    const echo = await page.evaluate(() => ({
      method: document.getElementById("method")?.textContent,
      body: document.getElementById("body")?.textContent,
      query: document.getElementById("query")?.textContent,
    }));
    expect(echo.method).toBe(scenario.method.toUpperCase());
    expect(echo.body).toBe(scenario.expectedBody);
    expect(echo.query).toBe(scenario.expectedQuery);
    expect(formNavigations).toBe(1);
    formNavigations = 0;
  }
}, 120_000);

test("mouse input dispatches the pointer stream used by select widgets", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/events.html", {
    waitUntil: "domcontentloaded",
  });
  const session = await page.createCDPSession();

  const point = await page.evaluate(() => {
    document.body.innerHTML = `<button id="trigger">Open</button>`;
    const trigger = document.querySelector("#trigger")!;
    const w = globalThis as typeof globalThis & {
      __ks_pointerLog: string[];
      __ks_pointerDetails: unknown;
    };
    w.__ks_pointerLog = [];
    trigger.addEventListener("pointerdown", (event) => {
      const pointer = event as PointerEvent;
      const current = event.currentTarget as Element;
      current.hasPointerCapture(pointer.pointerId);
      current.setPointerCapture(pointer.pointerId);
      current.releasePointerCapture(pointer.pointerId);
      w.__ks_pointerDetails = {
        pointerId: pointer.pointerId,
        pointerType: pointer.pointerType,
        isPrimary: pointer.isPrimary,
        isTrusted: pointer.isTrusted,
      };
      w.__ks_pointerLog.push("pointerdown");
      event.preventDefault();
    });
    trigger.addEventListener("pointerup", () => w.__ks_pointerLog.push("pointerup"));
    trigger.addEventListener("pointermove", () => w.__ks_pointerLog.push("pointermove"));
    trigger.addEventListener("mousedown", () => w.__ks_pointerLog.push("mousedown"));
    trigger.addEventListener("mousemove", () => w.__ks_pointerLog.push("mousemove"));
    trigger.addEventListener("mouseup", () => w.__ks_pointerLog.push("mouseup"));
    trigger.addEventListener("click", () => w.__ks_pointerLog.push("click"));
    const rect = trigger.getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  });

  await session.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x + 1,
    y: point.y,
    button: "left",
    buttons: 1,
  });
  await session.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x + 1,
    y: point.y,
    button: "left",
    clickCount: 1,
  });

  const result = await page.evaluate(() => {
    const w = globalThis as typeof globalThis & {
      __ks_pointerLog: string[];
      __ks_pointerDetails: unknown;
    };
    return { log: w.__ks_pointerLog, details: w.__ks_pointerDetails };
  });
  expect(result.log).toEqual(["pointerdown", "pointermove", "pointerup", "click"]);
  expect(result.details).toEqual({
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    isTrusted: true,
  });
}, 120_000);

test("mouse caret placement drives subsequent text edits", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/events.html", {
    waitUntil: "domcontentloaded",
  });
  const session = await page.createCDPSession();

  const point = await page.evaluate(async () => {
    document.body.innerHTML = `<textarea id="editor" style="width:400px;height:40px"></textarea>`;
    const editor = document.querySelector("#editor") as HTMLTextAreaElement;
    editor.value = "0123456789abcdef";
    editor.setSelectionRange(editor.value.length, editor.value.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
    (globalThis as typeof globalThis & { __ks_selectCount: number }).__ks_selectCount = 0;
    editor.addEventListener("select", () => {
      (globalThis as typeof globalThis & { __ks_selectCount: number }).__ks_selectCount++;
    });
    const rect = editor.getBoundingClientRect();
    return { x: Math.round(rect.x + 1), y: Math.round(rect.y + rect.height / 2) };
  });

  for (const type of ["mousePressed", "mouseReleased"] as const) {
    await session.send("Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
  }
  const afterClick = await page.evaluate(() => {
    const editor = document.querySelector("#editor") as HTMLTextAreaElement;
    return { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd };
  });
  expect(afterClick.start).toBe(0);
  expect(afterClick.end).toBe(0);

  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "X",
    code: "KeyX",
    text: "X",
    unmodifiedText: "X",
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "X",
    code: "KeyX",
  });
  const afterInsert = await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const editor = document.querySelector("#editor") as HTMLTextAreaElement;
    return {
      value: editor.value,
      start: editor.selectionStart,
      end: editor.selectionEnd,
      selectEvents: (globalThis as typeof globalThis & { __ks_selectCount: number })
        .__ks_selectCount,
    };
  });
  expect(afterInsert).toEqual({
    value: "X0123456789abcdef",
    start: 1,
    end: 1,
    selectEvents: 0,
  });

  await page.evaluate(() => {
    const editor = document.querySelector("#editor") as HTMLTextAreaElement;
    editor.value = "A" + String.fromCodePoint(0x1f600) + "B";
    editor.setSelectionRange(3, 3);
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
  });
  const afterBackspace = await page.evaluate(() => {
    const editor = document.querySelector("#editor") as HTMLTextAreaElement;
    return { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd };
  });
  expect(afterBackspace).toEqual({ value: "AB", start: 1, end: 1 });

  await page.evaluate(() => {
    const editor = document.querySelector("#editor") as HTMLTextAreaElement;
    editor.value = "A" + String.fromCodePoint(0x1f600) + "B";
    editor.setSelectionRange(1, 1);
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Delete",
    code: "Delete",
  });
  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Delete",
    code: "Delete",
  });
  const afterDelete = await page.evaluate(() => {
    const editor = document.querySelector("#editor") as HTMLTextAreaElement;
    return { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd };
  });
  expect(afterDelete).toEqual({ value: "AB", start: 1, end: 1 });
}, 120_000);
