// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A link that targets `_blank` opens another browsing context and leaves this
// document in place. Navigating the current tab loses the page the visitor was
// on.
// https://html.spec.whatwg.org/multipage/links.html#attr-hyperlink-target
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const LANDING = "http://127.0.0.1:8787/__fixtures/navigation-landing.html";

async function waitForUrl(page: { evaluate: (fn: () => string) => Promise<unknown> }) {
  const deadline = Date.now() + 15_000;
  let current = "";
  while (Date.now() < deadline) {
    current = (await page.evaluate(() => location.href).catch(() => "")) as string;
    if (current === LANDING) return current;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return current;
}

test("a target=_blank link keeps the current document", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>Targets</title>
    <a id="blank" target="_blank" href="${LANDING}">new tab</a>
    <a id="named" target="promo" href="${LANDING}">named</a>
    <a id="self" target="_self" href="${LANDING}">same tab</a>`,
  );
  const before = await page.evaluate(() => location.href);
  await page.click("#blank");
  await page.click("#named");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(await page.evaluate(() => location.href)).toBe(before);
  await page.click("#self");
  expect(await waitForUrl(page)).toBe(LANDING);
}, 60_000);
