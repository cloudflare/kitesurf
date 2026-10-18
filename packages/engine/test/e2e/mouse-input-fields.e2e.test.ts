// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

declare global {
  interface Window {
    events: Array<{
      type: string;
      x: number;
      y: number;
      buttons: number;
      movement: [number, number];
    }>;
  }
}

const PAGE = `<!doctype html><body style="margin:0;height:500px">
<script>
window.events = [];
for (const type of ["mousedown", "mouseup", "mousemove"]) {
  document.addEventListener(type, event => window.events.push({
    type: event.type, x: event.clientX, y: event.clientY,
    buttons: event.buttons, movement: [event.movementX, event.movementY]
  }));
}
</script>`;

test("CDP mouse payloads preserve named buttons and explicit bitmaps", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, PAGE);
  await cdpSession.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: 20,
    y: 15,
    button: "left",
  });
  await cdpSession.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 40,
    y: 20,
    button: "left",
  });
  await cdpSession.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: 40,
    y: 20,
    button: "left",
  });
  await cdpSession.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: 40,
    y: 20,
    button: "right",
    buttons: 1,
  });
  await cdpSession.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: 40,
    y: 20,
    button: "right",
    buttons: 3,
  });
  expect(
    await page.evaluate(() => window.events.map((event) => [event.type, event.buttons])),
  ).toEqual([
    ["mousedown", 1],
    ["mousemove", 1],
    ["mouseup", 0],
    ["mousedown", 3],
    ["mouseup", 1],
  ]);
});

test("named-button drag moves coalesce and flush the latest position before release", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, PAGE);
  const moveCount = 48;
  await cdpSession.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: 20,
    y: 15,
    button: "left",
  });
  for (let i = 1; i <= moveCount; i++) {
    await cdpSession.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 20 + i,
      y: 15,
      button: "left",
    });
  }
  await cdpSession.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: 20 + moveCount,
    y: 15,
    button: "left",
  });

  const events = await page.evaluate(() =>
    window.events.map(({ type, x, y, buttons }) => ({ type, x, y, buttons })),
  );
  const moves = events.filter(({ type }) => type === "mousemove");
  expect(moves.length).toBeLessThan(moveCount);
  expect(moves.at(-1)).toEqual({ type: "mousemove", x: 20 + moveCount, y: 15, buttons: 1 });
  expect(events.at(-1)).toEqual({ type: "mouseup", x: 20 + moveCount, y: 15, buttons: 0 });
});

test("explicit held-button bitmaps keep every drag move", async ({ page, cdpSession }) => {
  await setContent(page, PAGE);
  const moveCount = 8;
  await cdpSession.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: 20,
    y: 15,
    button: "left",
    buttons: 1,
  });
  for (let i = 1; i <= moveCount; i++) {
    await cdpSession.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: 20 + i,
      y: 15,
      button: "left",
      buttons: 1,
    });
  }
  await cdpSession.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: 20 + moveCount,
    y: 15,
    button: "left",
    buttons: 1,
  });

  expect(
    await page.evaluate(() => window.events.filter(({ type }) => type === "mousemove").length),
  ).toBe(moveCount);
});

test("mouse movement is relative to the last delivered position", async ({ page, cdpSession }) => {
  await setContent(page, PAGE);
  expect(
    await page.evaluate(() => {
      const empty = new MouseEvent("mousemove");
      const initialized = new MouseEvent("mousemove", { movementX: 7, movementY: -3 });
      return [
        [empty.movementX, empty.movementY],
        [initialized.movementX, initialized.movementY],
      ];
    }),
  ).toEqual([
    [0, 0],
    [7, -3],
  ]);
  await cdpSession.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 10 });
  await cdpSession.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: 20,
    y: 15,
    button: "left",
  });
  await cdpSession.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 40,
    y: 20,
    button: "left",
  });
  await cdpSession.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: 50,
    y: 30,
    button: "left",
  });
  await cdpSession.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 60, y: 35 });
  await page.waitForFunction(() => window.events.at(-1)?.x === 60);
  expect(await page.evaluate(() => window.events.map((event) => event.movement))).toEqual([
    [0, 0],
    [0, 0],
    [20, 5],
    [0, 0],
    [10, 5],
  ]);
});
