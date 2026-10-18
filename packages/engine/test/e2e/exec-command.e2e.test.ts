// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("execCommand edits the selection and queryCommand* reports it", async ({ page }) => {
  await setContent(page, "<div id=host contenteditable>foo bar</div>");

  const r = await page.evaluate(() => {
    const d = document;
    const host = document.getElementById("host")!;
    const text = host.firstChild!;

    const boldNoRange = d.execCommand("bold");
    const boldEnabledNoRange = d.queryCommandEnabled("bold");

    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 3);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);

    const stateBefore = d.queryCommandState("bold");
    const boldRet = d.execCommand("bold");
    const htmlAfterBold = host.innerHTML;
    const stateAfter = d.queryCommandState("bold");

    const all = document.createRange();
    all.selectNodeContents(host);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(all);
    const indetermMixed = d.queryCommandIndeterm("bold");

    return {
      boldNoRange,
      boldEnabledNoRange,
      stateBefore,
      boldRet,
      htmlAfterBold,
      stateAfter,
      indetermMixed,

      scssRet: d.execCommand("styleWithCSS", false, "true"),
      scssTrue: d.queryCommandState("stylewithcss"),
      scssOffRet: d.execCommand("styleWithCSS", false, "FaLsE"),
      scssOff: d.queryCommandState("stylewithcss"),
      scssPadded:
        (d.execCommand("styleWithCSS", false, " false"), d.queryCommandState("stylewithcss")),
      scssValue: d.queryCommandValue("styleWithCSS"),

      dpsDefault: d.queryCommandValue("defaultparagraphseparator"),
      dpsRet: d.execCommand("defaultParagraphSeparator", false, "P"),
      dpsAfter: d.queryCommandValue("defaultparagraphseparator"),
      dpsBadRet: d.execCommand("defaultParagraphSeparator", false, " div "),
      dpsUnchanged: d.queryCommandValue("defaultparagraphseparator"),

      // Limitation: clipboard commands return false because no clipboard exists.
      copyRet: d.execCommand("copy"),
      copySupported: d.queryCommandSupported("copy"),
      boldSupported: d.queryCommandSupported("bold"),
    };
  });

  expect(r).toEqual({
    boldNoRange: false,
    boldEnabledNoRange: false,
    stateBefore: false,
    boldRet: true,
    htmlAfterBold: "<b>foo</b> bar",
    stateAfter: true,
    indetermMixed: true,

    scssRet: true,
    scssTrue: true,
    scssOffRet: true,
    scssOff: false,
    scssPadded: true,
    scssValue: "",

    dpsDefault: "div",
    dpsRet: true,
    dpsAfter: "p",
    dpsBadRet: false,
    dpsUnchanged: "p",

    copyRet: false,
    copySupported: false,
    boldSupported: true,
  });
});
