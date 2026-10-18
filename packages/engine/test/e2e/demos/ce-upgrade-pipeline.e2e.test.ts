// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("ce-upgrade-pipeline", async ({ page }) => {
  await page.goto("http://localhost:8787/__fixtures/ce-mixin-late.html", {
    waitUntil: "load",
    timeout: 60000,
  });
  await page
    .waitForFunction(
      `(() => {
        const w = document.querySelector("my-mixed-widget");
        const cls = customElements.get("my-mixed-widget");
        const sr = w && w.shadowRoot;
        const nested = sr && sr.querySelector("my-nested-widget");
        return window.__chunkLoaded === true
          && !!(cls && w && cls.prototype.isPrototypeOf(w))
          && w._ctorRan === true
          && !!(nested && nested.shadowRoot
                && String(nested.shadowRoot.innerHTML).length > 0);
      })()`,
      { timeout: 30000 },
    )
    .catch(() => {});
  const probe = (await page.evaluate(`(() => {
    const w = document.querySelector("my-mixed-widget");
    const cls = customElements.get("my-mixed-widget");
    const sr = w && w.shadowRoot;
    const nested = sr && sr.querySelector("my-nested-widget");
    return {
      chunkLoaded: window.__chunkLoaded === true,
      upgraded: !!(cls && cls.prototype.isPrototypeOf(w)),
      ctorRan: w && w._ctorRan === true,
      outerShadow: sr ? String(sr.innerHTML) : null,
      nestedShadow: nested && nested.shadowRoot ? String(nested.shadowRoot.innerHTML) : null,
    };
  })()`)) as {
    chunkLoaded: boolean;
    upgraded: boolean;
    ctorRan: boolean;
    outerShadow: string | null;
    nestedShadow: string | null;
  };
  expect(probe.chunkLoaded, "late chunk import resolved").toBe(true);
  expect(probe.upgraded, "element upgraded to the chunk's class").toBe(true);
  expect(probe.ctorRan, "constructor ran with brand preservation").toBe(true);
  expect(probe.outerShadow).toContain("<b>pm-42-l10n:x</b>");
  expect(probe.nestedShadow).toBe("<i>nested-up</i>");
});
