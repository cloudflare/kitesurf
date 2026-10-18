// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import html from "./html/script-font-dir.html?raw";

test("script font references and :dir()", async ({ page, cdpSession: cdp }) => {
  await setContent(page, html);

  const directions = await page.evaluate(() => {
    const inherited = document.getElementById("inherited-child")!;
    const auto = document.getElementById("auto-pruned")!;
    const mutable = document.getElementById("mutable")!;
    const shadow = document
      .getElementById("shadow-host")!
      .shadowRoot!.getElementById("shadow-child")!;
    const input = document.getElementById("input-auto") as HTMLInputElement;
    const textarea = document.getElementById("textarea-auto") as HTMLTextAreaElement;
    const beforeMutation = mutable.matches(":dir(ltr)");
    const inputPlaceholderIgnored = ((input.value = ""), input.matches(":dir(ltr)"));
    mutable.textContent = "اختبر";
    input.value = "اختبر";
    textarea.value = "اختبر";
    return {
      inherited: inherited.matches(":dir(rtl)"),
      autoPrunesNestedDir: auto.matches(":dir(rtl)"),
      shadowInheritsHost: shadow.matches(":dir(rtl)"),
      beforeMutation,
      inputPlaceholderIgnored,
      afterMutation: mutable.matches(":dir(rtl)"),
      inputValue: input.matches(":dir(rtl)"),
      textareaValue: textarea.matches(":dir(rtl)"),
    };
  });
  expect(directions).toEqual({
    inherited: true,
    autoPrunesNestedDir: true,
    shadowInheritsHost: true,
    beforeMutation: true,
    inputPlaceholderIgnored: true,
    afterMutation: true,
    inputValue: true,
    textareaValue: true,
  });

  const dump = await cdp.send("Kitesurf.getFontFaces");
  const families = Object.values("byTarget" in dump ? dump.byTarget : {}).flatMap((entry) =>
    entry?.json ? (JSON.parse(entry.json) as Array<{ family: string }>) : [],
  );
  expect(families.some((font) => font.family === "Noto Sans Hebrew")).toBe(true);
});
