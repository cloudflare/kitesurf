// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

declare global {
  interface Window {
    __abschain?: { root?: string; entry?: string };
  }
}

test("absolute-path-transitive-demo", async ({ page, cdpSession: cdp }) => {
  const BASE = "http://127.0.0.1:8787";

  const errors = [];
  await cdp.send("Network.enable");
  const dependencyRequests: string[] = [];
  cdp.on("Network.requestWillBeSent", (event) => {
    if (event.request.url.endsWith("/__fixtures/abs-chain-dep.js")) {
      dependencyRequests.push(event.request.url);
    }
  });
  page.on("pageerror", (e) => errors.push((e.message || "").slice(0, 200)));

  await page.goto(BASE + "/__fixtures/absolute-path-transitive.html");
  await page
    .waitForFunction(
      () =>
        window.__abschain?.root === "root+dep loaded" &&
        window.__abschain?.entry === "entry+dep loaded",
      { timeout: 15_000 },
    )
    .catch(() => {});

  const probe = await page.evaluate(() => window.__abschain);
  expect(
    errors.length === 0,
    "imports resolved (no 'No such module' error): pageerrors: " + JSON.stringify(errors),
  ).toBeTruthy();
  expect(
    probe?.root === "root+dep loaded",
    "static absolute-path chain reached the relative dep: got: " + JSON.stringify(probe),
  ).toBeTruthy();
  expect(
    probe?.entry === "entry+dep loaded",
    "dynamic absolute-path chain reached the relative dep: got: " + JSON.stringify(probe),
  ).toBeTruthy();
  expect(
    dependencyRequests,
    "in-flight dedup: exactly one request for the abs-chain dep: got: " +
      JSON.stringify(dependencyRequests),
  ).toHaveLength(1);
});
