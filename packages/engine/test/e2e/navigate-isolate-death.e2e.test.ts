// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("a navigate whose page isolate dies before the page is ready fails", async ({
  browserFactory,
}) => {
  const browser = await browserFactory({ query: "?ksWallCapMs=800" });
  const page = await browser.newPage();
  // The parser-blocking script waits for the slow stylesheet, so the wall cap fires while the
  // navigate is still in flight, before the new page is published.
  const html =
    '<link rel="stylesheet" href="https://ks.invalid/__fixtures/slow-css?ms=2000">' +
    '<script>document.title = "ran";</script><p>never ready</p>';
  await expect(setContent(page, html)).rejects.toThrow(/wall-clock cap/);
}, 60_000);
