// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { waitForTitle } from "../waits";

const EXPECTED = {
  loaded: true,
  boaMapMethods: true,
  boaMapInstanceof: true,
  boaMapIterate: true,
  boaSetMethods: true,
  boaSetInstanceof: true,
  boaDateMethods: true,
  boaDateInstanceof: true,
  boaReTest: true,
  boaReInstanceof: true,
  v8MapToBoa: true,
  v8DateToBoa: true,
  boaMapTag: true,
};

test("boa-seam-collections-demo", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/seam-collections.html", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const title = await waitForTitle(page, "SEAM:", {
    prefix: true,
    timeout: 20000,
  });
  expect(title.startsWith("SEAM:"), "fixture never reported (title=" + title + ")").toBeTruthy();

  const actual = JSON.parse(title.slice("SEAM:".length));
  for (const [k, want] of Object.entries(EXPECTED)) {
    expect(actual[k], k).toStrictEqual(want);
  }
});
