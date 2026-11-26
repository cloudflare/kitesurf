// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const FROM = "https://ks.invalid/__fixtures/events.html";

// Playwright's page-autowaiting-no-hang assigns about:blank from an evaluate. When the
// navigation's first event beat the reply, the evaluate rejected: execution context destroyed.
test("an evaluate that assigns location replies before the navigation starts", async ({
  page,
  cdpSession: cdp,
}) => {
  await page.goto(FROM, { waitUntil: "load" });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  const order: string[] = [];
  cdp.on("Runtime.executionContextDestroyed", () => order.push("contextDestroyed"));
  cdp.on("Page.frameStartedLoading", () => order.push("frameStartedLoading"));
  cdp.on("Page.frameRequestedNavigation", () => order.push("frameRequestedNavigation"));
  const navigated = new Promise<string>((resolve) => {
    cdp.on("Page.frameNavigated", (event) => resolve(event.frame.url));
  });
  const reply = await cdp.send("Runtime.evaluate", {
    expression: `window.location.href = "about:blank";`,
    returnByValue: true,
  });
  order.push("reply");
  expect(reply.exceptionDetails).toBeUndefined();
  expect(reply.result.value).toBe("about:blank");
  expect(order[0]).toBe("reply");
  expect(await navigated).toBe("about:blank");
}, 60_000);
