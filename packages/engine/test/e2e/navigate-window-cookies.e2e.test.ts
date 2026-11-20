// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Page.navigate names the next document in target.url while it fetches it, and the outgoing
// document keeps running until then. Its cookie writes must not land on the next host.
import type { Page } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const NEXT = "https://ks-other.invalid/__fixtures/slow-document.html?ms=2000";

async function waitForNext(page: Page) {
  await expect.poll(() => page.url(), { timeout: 15_000 }).toBe(NEXT);
  await expect
    .poll(() => page.evaluate(() => document.title), { timeout: 15_000 })
    .toBe("Slow document");
}

test("an outgoing document's background cookie writes stay off the next host", async ({
  page,
  cdpSession,
}) => {
  await setContent(
    page,
    `<!doctype html><title>outgoing</title><script>
      setTimeout(() => {
        location.href = ${JSON.stringify(NEXT)};
        setInterval(() => { document.cookie = "ks_background=1; Path=/"; }, 20);
      }, 500);
    </script>`,
  );
  await cdpSession.send("DOM.enable");
  await waitForNext(page);

  const { cookies } = await cdpSession.send("Network.getAllCookies");
  expect(cookies.filter((c) => c.name === "ks_background")).toEqual([]);
}, 30_000);

test("an evaluate reply held across a navigate keeps its cookie writes off the next host", async ({
  page,
  cdpSession,
}) => {
  // The page settles its own replies, so it can hold one until its navigation has started.
  await setContent(
    page,
    `<!doctype html><title>outgoing</title><script>
      const held = new WeakSet();
      Object.defineProperty(Object.prototype, "then", {
        configurable: true,
        get() {
          const reply = this;
          const own = (k) => Object.prototype.hasOwnProperty.call(reply, k);
          if (held.has(reply) || !own("cookieWrites") || !own("ok")) return undefined;
          if (!reply.cookieWrites.length) return undefined;
          held.add(reply);
          return (resolve) => {
            location.href = ${JSON.stringify(NEXT)};
            setTimeout(() => resolve(reply), 500);
          };
        },
      });
    </script>`,
  );
  await cdpSession
    .send("Runtime.evaluate", { expression: 'document.cookie = "ks_held=1; Path=/"; 2' })
    .catch(() => {});
  await waitForNext(page);

  const { cookies } = await cdpSession.send("Network.getAllCookies");
  expect(cookies.filter((c) => c.name === "ks_held")).toEqual([]);
}, 30_000);
