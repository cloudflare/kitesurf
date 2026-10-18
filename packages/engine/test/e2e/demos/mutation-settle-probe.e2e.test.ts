// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";

test("captures a frame during continuous DOM mutation", async ({ page }) => {
  await setContent(
    page,
    `<div id="root"></div>
<script>
window.__bump = function() {
  const span = document.createElement("span");
  span.textContent = "x";
  document.getElementById("root").appendChild(span);
};
</script>`,
  );
  const session = await page.createCDPSession();

  try {
    await session.send("Runtime.evaluate", {
      expression: "window.__intervalId = setInterval(window.__bump, 5)",
      returnByValue: true,
    });
    await page.waitForFunction(() => document.querySelector("#root span") !== null);

    const screenshot = await session.send("Page.captureScreenshot", { format: "png" });
    expect(screenshot.data, "captureScreenshot returns image data during mutation").toBeTruthy();
  } finally {
    await session.send("Runtime.evaluate", {
      expression: "clearInterval(window.__intervalId)",
      returnByValue: true,
    });
    await session.detach();
  }
});
