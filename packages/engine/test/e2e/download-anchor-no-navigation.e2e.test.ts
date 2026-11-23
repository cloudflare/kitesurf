// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A `download` anchor saves a blob: or data: target instead of navigating to
// it. Following it replaces the document the page is working in.
// https://html.spec.whatwg.org/multipage/links.html#downloading-resources
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const LANDING = "http://127.0.0.1:8787/__fixtures/navigation-landing.html";

async function waitForUrl(page: {
  evaluate: (fn: () => string) => Promise<unknown>;
}): Promise<string> {
  const deadline = Date.now() + 15_000;
  let current = "";
  while (Date.now() < deadline) {
    current = (await page.evaluate(() => location.href).catch(() => "")) as string;
    if (current === LANDING) return current;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return current;
}

test("a download anchor keeps the current document", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>Downloads</title>
    <a id="data" download="note.txt" href="data:text/plain,hello">data</a>
    <a id="blob" download href="about:blank">blob</a>
    <a id="plain" href="${LANDING}">navigate</a>
    <script>
      document.getElementById("blob").href = URL.createObjectURL(new Blob(["x"]));
    </script>`,
  );
  const before = await page.evaluate(() => location.href);
  await page.click("#data");
  await page.click("#blob");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(await page.evaluate(() => location.href)).toBe(before);
  await page.click("#plain");
  expect(await waitForUrl(page)).toBe(LANDING);
}, 60_000);
