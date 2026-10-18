// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

interface Spy {
  setterCalls: number;
  inputEvents: number;
}

test("typed input bypasses a framework value descriptor", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/keyboard.html", {
    waitUntil: "domcontentloaded",
  });
  const session = await page.createCDPSession();

  const installSpy = () =>
    page.evaluate(() => {
      const node = document.querySelector("#i") as HTMLInputElement;
      const w = globalThis as typeof globalThis & { __ks_spy: Spy; __ks_spyBound?: boolean };
      w.__ks_spy = { setterCalls: 0, inputEvents: 0 };
      Object.defineProperty(node, "value", {
        configurable: true,
        get() {
          return "(spied)";
        },
        set() {
          w.__ks_spy.setterCalls++;
        },
      });
      if (!w.__ks_spyBound) {
        w.__ks_spyBound = true;
        node.addEventListener("input", () => {
          w.__ks_spy.inputEvents++;
        });
      }
      node.focus();
    });

  const realValue = () =>
    page.evaluate(() => {
      const node = document.querySelector("#i") as HTMLInputElement;
      const w = globalThis as typeof globalThis & { __ks_spy: Spy };
      const spy = { ...w.__ks_spy };
      const valueSlot: { value?: unknown } = node;
      delete valueSlot.value;
      return { value: node.value, ...spy };
    });

  await installSpy();
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", text: "a" });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a" });
  const typed = await realValue();
  expect(typed).toEqual({ value: "a", setterCalls: 0, inputEvents: 1 });

  await installSpy();
  await session.send("Input.insertText", { text: "bc" });
  expect(await realValue()).toEqual({ value: "abc", setterCalls: 0, inputEvents: 1 });

  await installSpy();
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace" });
  expect(await realValue()).toEqual({ value: "ab", setterCalls: 0, inputEvents: 1 });
}, 120_000);
