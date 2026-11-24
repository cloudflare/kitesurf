// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A link with a named target matching an `<iframe name>` routes to that iframe
// and keeps the top document; `_blank` and unmatched named targets continue
// navigating the current tab until popup targets exist.
// https://html.spec.whatwg.org/multipage/links.html#attr-hyperlink-target
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const LANDING = "http://127.0.0.1:8787/__fixtures/navigation-landing.html";

async function waitForUrl(
  page: { evaluate: (fn: () => string) => Promise<unknown> },
  expected: string,
) {
  const deadline = Date.now() + 15_000;
  let current = "";
  while (Date.now() < deadline) {
    current = (await page.evaluate(() => location.href).catch(() => "")) as string;
    if (current === expected) return current;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return current;
}

test("named target routes to a matching iframe while _blank navigates the current tab", async ({
  page,
}) => {
  await setContent(
    page,
    `<!doctype html><title>Targets</title>
    <iframe id="frame" name="promo" src="about:blank"></iframe>
    <a id="to-frame" target="promo" href="${LANDING}">named iframe</a>
    <a id="blank" target="_blank" href="${LANDING}">new tab</a>`,
  );
  const before = await page.evaluate(() => location.href);
  await page.click("#to-frame");
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(await page.evaluate(() => location.href)).toBe(before);
  expect(await page.evaluate(() => document.getElementById("frame")?.getAttribute("src"))).toBe(
    LANDING,
  );

  await page.click("#blank");
  expect(await waitForUrl(page, LANDING)).toBe(LANDING);
}, 60_000);
