// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

test("removeAttributeNS keeps a dirty checkbox's checkedness", async ({ browserFactory }) => {
  const browser = await browserFactory();
  const page = await browser.newPage();
  await setContent(
    page,
    '<input id="dirty" type="checkbox" checked><input id="clean" type="checkbox" checked>',
  );
  const result = await page.evaluate(() => {
    const dirty = document.querySelector<HTMLInputElement>("#dirty")!;
    const clean = document.querySelector<HTMLInputElement>("#clean")!;
    dirty.checked = true;
    dirty.removeAttributeNS(null, "checked");
    clean.removeAttributeNS(null, "checked");
    return {
      dirtyChecked: dirty.checked,
      dirtyMatches: dirty.matches(":checked"),
      cleanChecked: clean.checked,
      cleanMatches: clean.matches(":checked"),
    };
  });
  expect(result).toEqual({
    dirtyChecked: true,
    dirtyMatches: true,
    cleanChecked: false,
    cleanMatches: false,
  });
  await browser.disconnect();
});
