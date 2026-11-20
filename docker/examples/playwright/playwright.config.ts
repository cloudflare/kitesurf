// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { defineConfig } from "@playwright/test";

// Kitesurf has one browser context, which every test shares (tests/fixtures.ts), so run the
// tests one at a time.
export default defineConfig({
  testDir: "tests",
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
});
