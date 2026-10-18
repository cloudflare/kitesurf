// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { waitForTitle } from "./waits";

test("classic-script microtasks still see document.currentScript", async ({ browser }) => {
  const page = (await browser.pages())[0] ?? (await browser.newPage());

  await page.goto("http://127.0.0.1:8787/__fixtures/cs-microtask.html", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const title = await waitForTitle(page, "CSMICRO:", {
    prefix: true,
    timeout: 20_000,
  });
  expect(title.startsWith("CSMICRO:"), "fixture never reported (title=" + title + ")").toBeTruthy();

  const out = JSON.parse(title.slice("CSMICRO:".length));

  expect(out.syncRead, "syncRead").toMatchObject({
    src: "/__fixtures/cs-micro-a.js",
    isScriptEl: true,
  });
  expect(out.bSyncRead, "bSyncRead").toBe("/__fixtures/cs-micro-b.js");

  expect(out.microtaskRead, "microtaskRead").toMatchObject({
    src: "/__fixtures/cs-micro-a.js",
    isScriptEl: true,
  });

  expect(out.deepRead, "deepRead").toMatchObject({
    src: "/__fixtures/cs-micro-b.js",
    isScriptEl: true,
  });

  expect(out.macrotaskRead, "macrotaskRead").toBeNull();
});
