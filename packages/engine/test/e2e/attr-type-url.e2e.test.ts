// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// attr() output is attr()-tainted, and a tainted <url> is invalid, so `attr(x type(<url>))` never
// yields one: it falls back, or makes the declaration invalid at computed-value time.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("attr() with type(<url>) does not produce a url", async ({ page }) => {
  await setContent(
    page,
    `<style>
    #t {
      --url: attr(data-u type(<url>));
      --url-fallback: attr(data-u type(<url>), none);
      --number: attr(data-n type(<number>));
    }
  </style><div id=t data-u='url("https://example.test/a.png")' data-n="3"></div>`,
  );
  const read = await page.evaluate(() => {
    const el = document.getElementById("t");
    if (!el) throw new Error("no #t");
    const cs = getComputedStyle(el);
    return {
      url: cs.getPropertyValue("--url"),
      urlFallback: cs.getPropertyValue("--url-fallback"),
      number: cs.getPropertyValue("--number"),
    };
  });
  expect(read).toEqual({ url: "", urlFallback: "none", number: "3" });
}, 60_000);
