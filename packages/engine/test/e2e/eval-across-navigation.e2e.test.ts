// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("an in-flight evaluate rejects with Chrome's context-destroyed error", async ({ page }) => {
  await setContent(page, "<title>one</title>");

  const rejected = expect(page.evaluate(() => new Promise(() => {}))).rejects.toThrow(
    "Execution context was destroyed",
  );
  await setContent(page, "<title>two</title>");

  await rejected;
});
