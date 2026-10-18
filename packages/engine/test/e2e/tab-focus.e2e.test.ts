// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("Tab and Shift+Tab follow sequential focus order and honor cancellation", async ({
  page,
  cdpSession,
}) => {
  await setContent(
    page,
    `
    <style>a:focus { background-color: rgb(1, 2, 3) }</style>
    <a id="link" href="#done">follow me</a>
    <a id="empty-tabindex" href="#empty" tabindex="">empty</a>
    <a id="invalid-tabindex" href="#invalid" tabindex="abc">invalid</a>
    <a id="partial-tabindex" href="#partial" tabindex="3abc">partial</a>
    <div id="not-focusable" tabindex="abc">skip me</div>
    <button id="disabled" disabled>disabled</button>
    <a id="hidden" href="#hidden" style="display:none">hidden</a>
    <div id="inert" inert><a id="inert-link" href="#inert">inert</a></div>
    <input id="field">
    <a id="negative" href="#negative" tabindex="-1">negative</a>
    <div id="editable" contenteditable="true">edit</div>
    <div id="second" tabindex="2">second</div>
    <div id="first" tabindex="1">first</div>
    <a id="later" href="#later" style="margin-top: 600px; display:block">later</a>
    <div id="done">destination</div>
  `,
  );
  await page.setViewport({ width: 400, height: 160 });

  const key = async (modifiers = 0) => {
    await cdpSession.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Tab",
      code: "Tab",
      modifiers,
    });
    await cdpSession.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Tab",
      code: "Tab",
      modifiers,
    });
    return page.evaluate(() => document.activeElement?.id);
  };

  for (const id of [
    "first",
    "second",
    "link",
    "empty-tabindex",
    "invalid-tabindex",
    "partial-tabindex",
    "field",
    "editable",
    "later",
    "first",
  ]) {
    expect(await key()).toBe(id);
  }
  expect(await key(8)).toBe("later");
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  await page.evaluate(() => {
    const field = document.querySelector<HTMLInputElement>("#field");
    if (!field) throw new Error("Missing field");
    field.addEventListener("keydown", (event) => {
      event.preventDefault();
    });
    field.focus();
  });
  expect(await key()).toBe("field");
  expect(await key(8)).toBe("field");
  expect(
    await page.evaluate(() => {
      const link = document.querySelector<HTMLElement>("#link");
      if (!link) throw new Error("Missing link");
      link.focus();
      return getComputedStyle(link).backgroundColor;
    }),
  ).toBe("rgb(1, 2, 3)");

  await page.evaluate(() => {
    const link = document.querySelector<HTMLElement>("#link");
    if (!link) throw new Error("Missing link");
    link.dataset.clicks = "0";
    link.addEventListener("click", () => {
      link.dataset.clicks = String(Number(link.dataset.clicks) + 1);
    });
  });
  await cdpSession.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter" });
  expect(
    await page.evaluate(() => document.querySelector<HTMLElement>("#link")?.dataset.clicks),
  ).toBe("1");
  expect(await page.evaluate(() => location.hash)).toBe("#done");
}, 120_000);
