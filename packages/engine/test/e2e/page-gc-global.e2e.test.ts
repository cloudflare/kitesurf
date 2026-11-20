// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// The e2e config starts workerd with V8's --expose-gc, which gives every isolate gc(). The engine
// uses it to collect retired page isolates; Chrome has no gc(), so pages and workers must not.
test("pages and their workers do not see gc() under --expose-gc", async ({ page }) => {
  expect(typeof Reflect.get(globalThis, "gc"), "the test isolate runs with --expose-gc").toBe(
    "function",
  );

  await setContent(page, `<script>document.title = typeof gc;</script>`);
  expect(await page.title(), "a page script").toBe("undefined");
  expect(await page.evaluate("typeof gc"), "Runtime.evaluate").toBe("undefined");

  const inWorker = await page.evaluate(async () => {
    const source = `postMessage(typeof gc);`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(url);
    const seen = await new Promise((resolve) => (worker.onmessage = (e) => resolve(e.data)));
    worker.terminate();
    return seen;
  });
  expect(inWorker, "a dedicated worker").toBe("undefined");
});
