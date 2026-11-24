// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const DOC = "https://ks.invalid/__fixtures/echo-headers-frame.html";
const ECHO = "https://ks.invalid/__fixtures/echo-headers.json";

test("a loaded document's requests follow later header and user agent overrides", async ({
  page,
}) => {
  await page.setExtraHTTPHeaders({ "x-live": "one" });
  await page.goto(DOC, { waitUntil: "load" });
  const echo = async () =>
    JSON.parse(String(await page.evaluate(`fetch(${JSON.stringify(ECHO)}).then((r) => r.text())`)));

  expect((await echo())["x-live"]).toBe("one");

  await page.setExtraHTTPHeaders({ "x-live": "two" });
  await page.setUserAgent("live-agent/1.0");
  const changed = await echo();
  expect(changed["x-live"]).toBe("two");
  expect(changed["user-agent"]).toBe("live-agent/1.0");

  await page.setExtraHTTPHeaders({});
  expect((await echo())["x-live"]).toBeUndefined();
}, 120_000);
