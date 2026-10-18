// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

test("tty keeps TodoMVC's toggle-all control out of the new-todo value", async ({ page }) => {
  const html = `<!doctype html><style>
    .todoapp { position: relative }
    .new-todo { box-sizing: border-box; padding: 16px 16px 16px 60px; width: 100% }
    .main { position: relative }
    .toggle-all { bottom: 100%; position: absolute; right: 100%; width: 1px }
    .toggle-all + label { font-size: 0 }
    .toggle-all + label::before { content: "❯"; font-size: 22px }
  </style><section class="todoapp">
    <header><input class="new-todo" value="bread"></header>
    <main class="main">
      <input id="toggle-all" class="toggle-all" type="checkbox">
      <label for="toggle-all">Toggle All Input</label>
    </main>
  </section>`;
  await page.goto(`data:text/html,${encodeURIComponent(html)}?ks_tty_css=1&ks_tty_cell=8x17`, {
    waitUntil: "load",
  });

  const styles = await page.evaluate(() => {
    const input = document.querySelector(".new-todo")!;
    const label = document.querySelector("label")!;
    return {
      paddingLeft: getComputedStyle(input).paddingLeft,
      labelFontSize: getComputedStyle(label).fontSize,
      labelIcon: getComputedStyle(label, "::before").content,
    };
  });
  expect(Number.parseFloat(styles.paddingLeft)).toBeCloseTo(24, 1);
  expect(styles).toMatchObject({
    labelFontSize: "0px",
    labelIcon: "none",
  });
});
