// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("shadow roots adopt, update, and remove scoped constructed stylesheets", async ({ page }) => {
  await setContent(page, `<div id="host"></div><div id="outside">outside</div>`);
  const initial = await page.evaluate(() => {
    const host = document.getElementById("host")!;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = "<div>inside</div>";
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(":host { display: block; width: 123px; } div { color: rgb(1, 2, 3); }");
    root.adoptedStyleSheets = [sheet];
    return {
      color: getComputedStyle(root.querySelector("div")!).color,
      width: host.getBoundingClientRect().width,
      outside: getComputedStyle(document.getElementById("outside")!).color,
    };
  });
  expect(initial).toEqual({ color: "rgb(1, 2, 3)", width: 123, outside: "rgb(0, 0, 0)" });
  expect(
    await page.evaluate(() => {
      const root = document.getElementById("host")!.shadowRoot!;
      root.adoptedStyleSheets[0]!.replaceSync("div { color: rgb(4, 5, 6); }");
      return getComputedStyle(root.querySelector("div")!).color;
    }),
  ).toBe("rgb(4, 5, 6)");
  expect(
    await page.evaluate(() => {
      const root = document.getElementById("host")!.shadowRoot!;
      root.adoptedStyleSheets.pop();
      return getComputedStyle(root.querySelector("div")!).color;
    }),
  ).toBe("rgb(0, 0, 0)");
});

test("adopted sheets still apply after the shadow root's children are replaced", async ({
  page,
}) => {
  await setContent(page, `<div id="host"></div>`);
  const colors = await page.evaluate(() => {
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("div { color: rgb(1, 2, 3); }");
    root.adoptedStyleSheets = [sheet];
    const color = () => getComputedStyle(root.querySelector("div")!).color;
    root.innerHTML = "<div>first</div>";
    const afterInnerHTML = color();
    root.textContent = "";
    root.append(document.createElement("div"));
    const afterTextContent = color();
    root.replaceChildren(document.createElement("div"));
    return { afterInnerHTML, afterTextContent, afterReplaceChildren: color() };
  });
  expect(colors).toEqual({
    afterInnerHTML: "rgb(1, 2, 3)",
    afterTextContent: "rgb(1, 2, 3)",
    afterReplaceChildren: "rgb(1, 2, 3)",
  });
});

test("reordering adopted sheets reorders the cascade", async ({ page }) => {
  await setContent(page, `<div id="host"></div>`);
  const colors = await page.evaluate(() => {
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    root.innerHTML = "<div>inside</div>";
    const red = new CSSStyleSheet();
    red.replaceSync("div { color: rgb(255, 0, 0); }");
    const green = new CSSStyleSheet();
    green.replaceSync("div { color: rgb(0, 128, 0); }");
    const color = () => getComputedStyle(root.querySelector("div")!).color;
    root.adoptedStyleSheets = [red, green];
    const assigned = color();
    root.adoptedStyleSheets.reverse();
    const reversed = color();
    root.adoptedStyleSheets = [red, green];
    const reassigned = color();
    return { assigned, reversed, reassigned };
  });
  expect(colors).toEqual({
    assigned: "rgb(0, 128, 0)",
    reversed: "rgb(255, 0, 0)",
    reassigned: "rgb(0, 128, 0)",
  });
});

test("only constructed stylesheets can be adopted", async ({ page }) => {
  await setContent(page, `<style>div {}</style><div id="host"></div>`);
  const errors = await page.evaluate(() => {
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    const name = (assign: () => void) => {
      try {
        assign();
        return "no error";
      } catch (e) {
        return (e as Error).name;
      }
    };
    const treeSheet = document.styleSheets[0]!;
    return {
      shadowTreeSheet: name(() => (root.adoptedStyleSheets = [treeSheet])),
      shadowNotIterable: name(() => (root.adoptedStyleSheets = 5 as never)),
      documentTreeSheet: name(() => (document.adoptedStyleSheets = [treeSheet])),
      kept: root.adoptedStyleSheets.length,
    };
  });
  expect(errors).toEqual({
    shadowTreeSheet: "NotAllowedError",
    shadowNotIterable: "TypeError",
    documentTreeSheet: "NotAllowedError",
    kept: 0,
  });
});

test("a disabled adopted sheet leaves the cascade until it is enabled", async ({ page }) => {
  await setContent(page, `<div id="host"></div><p id="outside">outside</p>`);
  const colors = await page.evaluate(() => {
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    const sheet = new CSSStyleSheet({ disabled: true });
    sheet.replaceSync("div, p { color: rgb(255, 0, 0); }");
    root.adoptedStyleSheets = [sheet];
    document.adoptedStyleSheets = [sheet];
    root.innerHTML = "<style>div { color: rgb(0, 128, 0); }</style><div>inside</div>";
    const inside = () => getComputedStyle(root.querySelector("div")!).color;
    const outside = () => getComputedStyle(document.getElementById("outside")!).color;
    const disabled = { inside: inside(), outside: outside() };
    sheet.disabled = false;
    const enabled = { inside: inside(), outside: outside() };
    sheet.disabled = true;
    return { disabled, enabled, disabledAgain: { inside: inside(), outside: outside() } };
  });
  expect(colors).toEqual({
    disabled: { inside: "rgb(0, 128, 0)", outside: "rgb(0, 0, 0)" },
    enabled: { inside: "rgb(255, 0, 0)", outside: "rgb(255, 0, 0)" },
    disabledAgain: { inside: "rgb(0, 128, 0)", outside: "rgb(0, 0, 0)" },
  });
});
