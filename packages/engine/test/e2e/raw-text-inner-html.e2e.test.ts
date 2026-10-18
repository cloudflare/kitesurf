// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("raw-text elements serialize innerHTML without escaping", async ({ page }) => {
  const source = "if (a && b < c) run('x > y');";

  await setContent(
    page,
    `<script id="tpl" type="text/x-not-javascript">${source}</script>
     <style id="css">.a > .b { content: "&"; }</style>
     <pre id="pre">&lt;NAME&gt; &amp; co</pre>`,
    { waitUntil: "domcontentloaded" },
  );

  const out = await page.evaluate(() => {
    const script = document.getElementById("tpl")!;
    const style = document.getElementById("css")!;
    const pre = document.getElementById("pre")!;
    return {
      scriptInner: script.innerHTML,
      scriptText: script.textContent,
      styleInner: style.innerHTML,
      scriptOuter: script.outerHTML,
      preInner: pre.innerHTML,
      preText: pre.textContent,
    };
  });

  expect(out.scriptInner).toBe(source);
  expect(out.scriptText).toBe(source);
  expect(out.styleInner).toBe('.a > .b { content: "&"; }');
  expect(out.scriptOuter).toBe(`<script id="tpl" type="text/x-not-javascript">${source}</script>`);
  expect(out.preText).toBe("<NAME> & co");
  expect(out.preInner).toBe("&lt;NAME&gt; &amp; co");
});
