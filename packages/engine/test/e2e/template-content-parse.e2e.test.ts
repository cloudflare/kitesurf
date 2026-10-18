// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Parsed template children must populate `.content` through the parser, innerHTML, and
// declarative shadow roots.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("parsed templates keep their content", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html>
<template id="markup"><p class="x">from markup</p></template>
<div id="host"><template shadowrootmode="open"><span id="inner">shadow</span></template></div>
<div id="mount"></div>`,
    { waitUntil: "domcontentloaded" },
  );
  const got = await page.evaluate(() => {
    const markup = document.getElementById("markup") as HTMLTemplateElement;
    const mount = document.getElementById("mount")!;
    mount.innerHTML = '<template id="dyn"><b>from innerHTML</b></template>';
    const dyn = document.getElementById("dyn") as HTMLTemplateElement;
    const host = document.getElementById("host")!;
    return {
      markup: markup.content.querySelector(".x")?.textContent ?? null,
      markupOwnChildren: markup.childNodes.length,
      leaksIntoDocument: document.querySelector(".x") !== null,
      dyn: dyn.content.querySelector("b")?.textContent ?? null,
      shadow: host.shadowRoot?.getElementById("inner")?.textContent ?? null,
    };
  });
  expect(got).toEqual({
    markup: "from markup",
    markupOwnChildren: 0,
    leaksIntoDocument: false,
    dyn: "from innerHTML",
    shadow: "shadow",
  });
});
