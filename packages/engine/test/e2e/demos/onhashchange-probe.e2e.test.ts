// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

declare global {
  interface Document {
    documentMode?: number;
  }
}

test("onhashchange-probe", async ({ page }) => {
  const probe = await page.evaluate(() => {
    const out: {
      onhashchange_in_window?: boolean;
      onpopstate_in_window?: boolean;
      documentMode_is_undefined?: boolean;
      directorBranchTaken?: boolean;
      assignmentReadsBack?: boolean;
    } = {};
    out.onhashchange_in_window = "onhashchange" in window;
    out.onpopstate_in_window = "onpopstate" in window;
    out.documentMode_is_undefined = document.documentMode === undefined;
    out.directorBranchTaken =
      "onhashchange" in window &&
      (document.documentMode === undefined || document.documentMode > 7);

    let _fired = "not-yet";
    window.onhashchange = function (_e) {
      _fired = "called";
    };
    out.assignmentReadsBack = typeof window.onhashchange === "function";

    return out;
  });

  console.log("[probe] payload:", JSON.stringify(probe, null, 2));

  expect(
    probe.onhashchange_in_window,
    "'onhashchange' in window === true (else Director falls to iframe path)",
  ).toBeTruthy();
  expect(probe.onpopstate_in_window, "'onpopstate' in window === true").toBeTruthy();
  expect(probe.documentMode_is_undefined, "document.documentMode === undefined").toBeTruthy();
  expect(probe.directorBranchTaken, "Director would pick MODERN branch").toBeTruthy();
  expect(probe.assignmentReadsBack, "window.onhashchange = fn round-trips").toBeTruthy();
});
