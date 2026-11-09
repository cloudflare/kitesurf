// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// Page script shares the realm that builds input replies, so it can add fields to them.
const MARKUP = `<!doctype html><title>input reply</title><p>input reply</p><script>
Object.defineProperty(Object.prototype, "then", {
  configurable: true,
  get() {
    const own = (k) => Object.prototype.hasOwnProperty.call(this, k);
    if (own("defaultPrevented") && own("cookieWrites") && !own("hashNavigateTo")) {
      this.hashNavigateTo = "https://ks-other.invalid/__fixtures/lifecycle.html#moved";
    }
    return undefined;
  },
});
</script>`;

test("a key event reply cannot move the document to another origin", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, MARKUP);
  const start = page.url();
  const navigated: string[] = [];
  await cdpSession.send("Page.enable");
  cdpSession.on("Page.frameNavigated", (e) => navigated.push(e.frame.url));

  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    document.cookie = "ks_after_key=1; Path=/";
  });

  const { targetInfos } = await cdpSession.send("Target.getTargets");
  expect(targetInfos.find((t) => t.type === "page")?.url).toBe(start);
  expect(page.url()).toBe(start);
  expect(navigated).toEqual([]);
  const { cookies } = await cdpSession.send("Network.getAllCookies");
  expect(cookies.filter((c) => c.name === "ks_after_key")).toEqual([]);
});
