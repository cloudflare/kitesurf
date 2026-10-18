// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("keyboard-demo", async ({ page }) => {
  const FIXTURE_URL =
    process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/keyboard.html";

  await page.goto(FIXTURE_URL, { timeout: 15000 });

  const session = await page.target().createCDPSession();

  await session.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "A",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: 8,
  });

  await session.send("Input.dispatchKeyEvent", {
    type: "char",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
  });

  await session.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "A",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: 2,
  });

  await page
    .waitForFunction("(globalThis.__ks_keys || []).length >= 3", {
      timeout: 10000,
    })
    .catch(() => {});

  const events = await page.evaluate(() => globalThis.__ks_keys);
  console.log("[kb] captured events:");
  for (const e of events) console.log("  ", JSON.stringify(e));

  expect(events.length, "got 3 events").toBe(3);

  const e0 = events[0];
  expect(e0.type, "e0 type keydown").toBe("keydown");
  expect(e0.label, "e0 label doc:keydown").toBe("doc:keydown");
  expect(e0.key, "e0 key=A").toBe("A");
  expect(e0.code, "e0 code=KeyA").toBe("KeyA");
  expect(e0.keyCode, "e0 keyCode=65").toBe(65);
  expect(e0.which, "e0 which=keyCode").toBe(e0.keyCode);
  expect(e0.charCode, "e0 charCode=0 (not keypress)").toBe(0);
  expect(e0.shift, "e0 shift=true").toBe(true);
  expect(e0.ctrl, "e0 ctrl=false").toBe(false);
  expect(e0.isKeyboardEvent, "e0 instanceof KeyboardEvent").toBe(true);
  expect(e0.modShift, "e0 getModifierState('Shift')").toBe(true);

  const e1 = events[1];
  expect(e1.type, "e1 type keypress").toBe("keypress");
  expect(e1.charCode, "e1 charCode=97").toBe(97);
  expect(e1.isKeyboardEvent, "e1 instanceof KeyboardEvent").toBe(true);

  const e2 = events[2];
  expect(e2.type, "e2 type keyup").toBe("keyup");
  expect(e2.ctrl, "e2 ctrl=true").toBe(true);
  expect(e2.shift, "e2 shift=false").toBe(false);
});
