// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

const FIXTURE_URL = "https://ks.invalid/__fixtures/lifecycle.html";

test("initial URL navigates the first page", async ({ page, browserFactory }) => {
  await page.goto(FIXTURE_URL, { waitUntil: "load", timeout: 15_000 });

  const browser = await browserFactory({
    query: `?initialUrl=${encodeURIComponent(FIXTURE_URL)}`,
  });
  try {
    const autoNavigatedPage = (await browser.pages())[0]!;
    const navigation = autoNavigatedPage
      .waitForFunction(() => location.href !== "about:blank", {
        timeout: 15_000,
      })
      .catch(() => null);
    await navigation;
    expect(autoNavigatedPage.url(), "the connection's initial URL navigates the opened page").toBe(
      FIXTURE_URL,
    );
  } finally {
    await browser.disconnect();
  }
});
