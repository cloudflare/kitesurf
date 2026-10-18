// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("document.fonts.ready delegates to the lazy-font hook", async ({ page }) => {
  await page.goto("about:blank", { timeout: 20_000 });
  const observed = await page.evaluate(async () => {
    const g = globalThis as typeof globalThis & {
      __ks_fontsReady?: () => Promise<void>;
      __ks_fontsInflightCount?: () => number;
    };
    const hooksPresent =
      typeof g.__ks_fontsReady === "function" && typeof g.__ks_fontsInflightCount === "function";

    let inflight = 2;
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    g.__ks_fontsInflightCount = () => inflight;
    g.__ks_fontsReady = () => gate;

    const fonts = document.fonts;
    const statusWhileLoading = fonts.status;
    let resolved = false;
    const readyPromise = fonts.ready.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    const settledEarly = resolved;
    inflight = 0;
    resolveGate();
    await readyPromise;
    const statusAfter = fonts.status;
    return { hooksPresent, statusWhileLoading, settledEarly, statusAfter };
  });

  expect(observed.hooksPresent, "page-script published the hooks").toBe(true);
  expect(observed.statusWhileLoading, "status while inflight>0").toBe("loading");
  expect(observed.settledEarly, "ready did not resolve synchronously").toBe(false);
  expect(observed.statusAfter, "status after hook resolves").toBe("loaded");
});
