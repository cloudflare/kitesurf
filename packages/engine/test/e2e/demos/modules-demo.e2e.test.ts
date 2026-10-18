// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("modules-demo", async ({ page }) => {
  const FIXTURE_URL =
    process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/modules.html";

  await page.goto(FIXTURE_URL, { timeout: 15000 });

  const probe = await page.evaluate(() => ({
    log: globalThis.__ks_module_log,
    foo: globalThis.__ks_module_FOO,
    barSeen: globalThis.__ks_module_BAR_seen,
  }));
  console.log("[mod] log =", JSON.stringify(probe.log));

  const expected = [
    "classic-inline",
    "module-inline-1",
    "module-inline-1-after-await",
    "module-external",
    "module-inline-2",
  ];

  expect(probe.log, "module execution log order").toStrictEqual(expected);

  console.log("[mod] FOO =", probe.foo, "BAR_seen =", probe.barSeen);
  expect(probe.foo, "module side-effect FOO=42").toBe(42);
  expect(probe.barSeen, "module-inline-2 saw external module's BAR").toBe(7);
});
