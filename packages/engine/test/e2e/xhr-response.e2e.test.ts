// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("XMLHttpRequest.response caches the parsed JSON after completion", async ({ page }) => {
  await setContent(page, "<div></div>");
  const result = await page.evaluate(async () => {
    const url = URL.createObjectURL(new Blob(['{"answer":42}'], { type: "application/json" }));
    try {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url);
      xhr.responseType = "json";
      const before = xhr.response;
      await new Promise<void>((resolve, reject) => {
        xhr.onload = () => resolve();
        xhr.onerror = () => reject(new Error("XHR failed"));
        xhr.send();
      });
      const response = xhr.response;
      return { before, response, cached: response === xhr.response };
    } finally {
      URL.revokeObjectURL(url);
    }
  });
  expect(result).toEqual({ before: null, response: { answer: 42 }, cached: true });
});
