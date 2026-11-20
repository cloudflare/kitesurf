// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const ORIGIN = "http://127.0.0.1:8787";

// Page modules share the loaded worker, so its env is reachable through the
// built-in module; the engine's tail token must not be in it.
test("page script cannot read the engine tail token through cloudflare:workers", async ({
  page,
}) => {
  await page.goto(`${ORIGIN}/__fixtures/dynimport.html`, { waitUntil: "load", timeout: 30000 });
  const leaked = await page.evaluate(`
    import("cloudflare:" + "workers").then(
      (m) => (m && m.env && m.env.KS_TAIL_TOKEN) || null,
      () => null,
    )
  `);
  expect(leaked).toBeNull();
});
