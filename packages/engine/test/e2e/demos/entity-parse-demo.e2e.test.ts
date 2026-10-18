// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("entity-parse-demo", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/entity-parse.html", {
    waitUntil: "domcontentloaded",
    timeout: 15000,
  });
  const info = await page.evaluate(() => {
    const out: Record<string, { text: string; childCount: number; innerHTML: string } | null> = {};
    for (const id of ["test1", "test2", "test3", "test4"]) {
      const el = document.getElementById(id);
      if (!el) {
        out[id] = null;
        continue;
      }
      out[id] = {
        text: el.textContent,
        childCount: el.childNodes.length,
        innerHTML: el.innerHTML,
      };
    }
    return out;
  });

  expect(info.test1.text, "test1 text content preserved").toBe("before<STORAGE_ACCOUNT_NAME>after");
  expect(info.test1.childCount, "test1 has single text child").toBe(1);
  expect(info.test1.innerHTML, "test1 innerHTML re-escapes correctly").toBe(
    "before&lt;STORAGE_ACCOUNT_NAME&gt;after",
  );

  expect(info.test2.text, "test2 text preserved").toBe("a<foo>b");
  expect(info.test2.childCount, "test2 single text child").toBe(1);

  expect(info.test3.text, "test3 plain text unaffected").toBe("plain");
  expect(info.test3.childCount, "test3 single child").toBe(1);

  expect(info.test4.text, "test4 text content preserved").toBe("<X>");
  expect(info.test4.childCount, "test4 single text child").toBe(1);
});
