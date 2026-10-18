// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("network-ua-override-demo", async ({ page }) => {
  const ECHO = process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/echo-headers.html";
  const UA = "KitesurfOverride/9.9 (e2e test)";

  await page.setUserAgent(UA);
  await page.goto(ECHO, { timeout: 15000 });

  const gen1 = await page.evaluate(async () => {
    await globalThis.__ks_fetch_ready;
    return {
      doc: globalThis.__ks_doc_headers,
      sub: globalThis.__ks_fetch_headers,
      nav: navigator.userAgent,
    };
  });
  expect(gen1.doc["user-agent"], "doc fetch UA overridden").toBe(UA);
  expect(gen1.sub["user-agent"], "subresource fetch UA overridden").toBe(UA);
  expect(gen1.nav, "navigator.userAgent overridden").toBe(UA);

  const ALIAS_UA = "KitesurfEmulationAlias/1.1";
  const session = await page.target().createCDPSession();
  await session.send("Emulation.setUserAgentOverride", { userAgent: ALIAS_UA });
  await page.goto(ECHO, { timeout: 15000 });
  const gen2 = await page.evaluate(() => ({
    doc: globalThis.__ks_doc_headers,
    nav: navigator.userAgent,
  }));
  expect(gen2.doc["user-agent"], "Emulation alias doc UA").toBe(ALIAS_UA);
  expect(gen2.nav, "Emulation alias navigator.userAgent").toBe(ALIAS_UA);

  await page.setUserAgent("");
  await page.goto(ECHO, { timeout: 15000 });
  const gen3 = await page.evaluate(() => ({
    doc: globalThis.__ks_doc_headers,
    nav: navigator.userAgent,
  }));
  expect(
    typeof gen3.doc["user-agent"] === "string" && gen3.doc["user-agent"].includes("Mozilla/5.0"),
    "doc fetch UA back to default",
  ).toBeTruthy();
  expect(gen3.nav, "navigator.userAgent back to default").toBe("Kitesurf/0.0.1");
});
