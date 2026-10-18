// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";

test("supports document.write, fragment imports, and details toggling", async ({ page }) => {
  await setContent(page, "<body></body>");

  const result = await page.evaluate(() => {
    let writeThrew = false;
    let writeContinued = false;
    try {
      document.write("<span data-ksw>w</span>");
      writeContinued = true;
    } catch {
      writeThrew = true;
      writeContinued = false;
    }

    let importNodeType: number | null = null;
    let importChildCount = 0;
    let appendedHtml = "";
    try {
      const template = document.createElement("template");
      template.innerHTML = "<div class='imp'><b>hi</b></div>";
      const fragment = document.importNode(template.content, true);
      importNodeType = fragment ? fragment.nodeType : null;
      importChildCount = fragment ? fragment.childNodes.length : 0;
      const host = document.createElement("div");
      host.appendChild(fragment);
      appendedHtml = host.innerHTML;
    } catch {}

    let detailsToggled = false;
    try {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "x";
      details.appendChild(summary);
      details.appendChild(document.createElement("p"));
      document.body.appendChild(details);
      const before = details.open;
      summary.click();
      detailsToggled = details.open !== before;
    } catch {}

    return {
      writeThrew,
      writeContinued,
      importNodeType,
      importChildCount,
      appendedHtml,
      detailsToggled,
    };
  });

  expect(result.writeThrew, "document.write does not throw").toBe(false);
  expect(result.writeContinued, "execution continues after document.write").toBeTruthy();
  expect(result.importNodeType, "importNode returns a DocumentFragment").toBe(11);
  expect(result.importChildCount >= 1, "deep import copies fragment children").toBe(true);
  expect(result.appendedHtml, "appending the fragment moves its content").toContain("imp");
  expect(result.detailsToggled, "summary click toggles details open state").toBeTruthy();
});
