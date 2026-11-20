// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("a drag selection is readable after link navigation", async ({ page, cdpSession }) => {
  const destination = `data:text/html,${encodeURIComponent(
    "<!doctype html><p id=target>zero one two three four</p>",
  )}`;
  const source = `<!doctype html><a id=next href="${destination}">next</a>`;
  await page.goto(`data:text/html,${encodeURIComponent(source)}?ks_tty_css=1&ks_tty_cell=8x17`);
  await Promise.all([page.waitForNavigation({ waitUntil: "load" }), page.click("#next")]);

  const rect = await page.evaluate(() => {
    const r = document.querySelector("#target")!.getBoundingClientRect();
    const internals: unknown = Reflect.get(globalThis, Symbol.for("kitesurf.internals"));
    return {
      cellW:
        typeof internals === "object" && internals !== null
          ? Reflect.get(internals, "ttyCellWidth")
          : undefined,
      left: r.left,
      y: r.top + r.height / 2,
    };
  });
  expect(rect.cellW).toBe(8);
  const cw = rect.cellW!;
  const start = { x: rect.left + 5 * cw + cw / 2, y: rect.y };
  const end = { x: rect.left + 11 * cw + cw / 2, y: rect.y };

  await cdpSession.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...start,
  });
  await cdpSession.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    buttons: 1,
    clickCount: 1,
    ...start,
  });
  await cdpSession.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    button: "left",
    buttons: 1,
    ...end,
  });

  const selected = await page.evaluate(() => String(getSelection()));
  await cdpSession.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    buttons: 0,
    clickCount: 1,
    ...end,
  });
  expect(selected).toBe("one two");
});
