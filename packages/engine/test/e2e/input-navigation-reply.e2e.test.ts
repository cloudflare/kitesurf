// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A link click's mouseReleased replied only once the page it opened had loaded, so puppeteer's
// 5 s locator (chrome-devtools-mcp's click) reported clicks that had navigated as failures.
import { expect, test } from "./harness";

test("a link click replies on dispatch, and the next input waits for the navigation it started", async ({
  page,
}) => {
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", { waitUntil: "load" });
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.id = "slow";
    a.href = "/__fixtures/slow-document.html?ms=3000";
    a.textContent = "slow";
    a.style.cssText = "display:block;width:120px;height:40px";
    document.body.prepend(a);
  });
  const box = await (await page.$("#slow"))?.boundingBox();
  if (!box) throw new Error("#slow has no layout box");
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  const cdp = await page.createCDPSession();
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  const t0 = Date.now();
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  expect(Date.now() - t0).toBeLessThan(2_000);

  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
  expect(await page.evaluate(() => location.pathname + " " + document.title)).toBe(
    "/__fixtures/slow-document.html Slow document",
  );
}, 60_000);

test("a fragment link click has moved the frame's URL by the time it replies", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", { waitUntil: "load" });
  await page.evaluate(() => {
    const a = document.createElement("a");
    a.id = "frag";
    a.href = "#later";
    a.textContent = "later";
    a.style.cssText = "display:block;width:120px;height:40px";
    document.body.prepend(a);
  });
  const box = await (await page.$("#frag"))?.boundingBox();
  if (!box) throw new Error("#frag has no layout box");
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  const cdp = await page.createCDPSession();
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  const { frameTree } = await cdp.send("Page.getFrameTree");
  expect(frameTree.frame.url).toBe("https://ks.invalid/__fixtures/lifecycle.html#later");
}, 60_000);

test("Enter's implicit submit replies on dispatch, and the next input waits for the document it asked for", async ({
  page,
}) => {
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", { waitUntil: "load" });
  await page.evaluate(() => {
    const form = document.createElement("form");
    form.action = "/__fixtures/slow-document.html";
    const input = document.createElement("input");
    input.id = "ms";
    input.name = "ms";
    input.value = "3000";
    form.append(input);
    document.body.prepend(form);
  });
  await page.focus("#ms");
  const cdp = await page.createCDPSession();
  const t0 = Date.now();
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  });
  expect(Date.now() - t0).toBeLessThan(2_000);

  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  expect(
    await page.evaluate(() => location.pathname + location.search + " " + document.title),
  ).toBe("/__fixtures/slow-document.html?ms=3000 Slow document");
}, 60_000);
