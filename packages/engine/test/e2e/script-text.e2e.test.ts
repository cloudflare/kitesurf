// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// HTMLScriptElement.text is how pre-ES6 loaders build an inline script
// (`el.text = code; head.appendChild(el)`). Without it the script was
// inserted with no textContent and silently never ran.

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("script.text reads and writes the script's text, and a script built with it runs", async ({
  page,
}) => {
  await setContent(
    page,
    `<script id="s">var a = 1;</script>
     <script>
       var built = document.createElement("script");
       built.text = "window.ranFromText = true;";
       document.head.appendChild(built);
     </script>`,
    { waitUntil: "domcontentloaded" },
  );

  const out = await page.evaluate(() => {
    const s = document.getElementById("s");
    if (!(s instanceof HTMLScriptElement)) throw new Error("no #s script");
    const initial = s.text;
    s.text = "var b = 2;";
    const written = s.textContent;
    Reflect.set(s, "text", null);
    const nulled = s.text;
    return { initial, written, nulled, ran: Reflect.get(window, "ranFromText") === true };
  });

  expect(out).toEqual({
    initial: "var a = 1;",
    written: "var b = 2;",
    nulled: "null",
    ran: true,
  });
});
