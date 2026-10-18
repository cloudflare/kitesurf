// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const LANDING = "http://127.0.0.1:8787/__fixtures/navigation-landing.html";

async function waitForUrl(read: () => Promise<string>, want: string, ms = 15_000): Promise<string> {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    last = await read().catch((err: unknown) => `evaluate failed: ${String(err)}`);
    if (last === want) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  return last;
}

for (const method of ["get", "post"] as const) {
  test(`a click on a submit button's inner span submits the form (${method})`, async ({ page }) => {
    await setContent(
      page,
      `<!doctype html><title>Form</title>
      <form action="${LANDING}" method="${method}"><input type="hidden" name="q" value="x">
        <button><span id="label" style="padding:20px;display:inline-block">Accept all</span></button>
      </form>`,
    );
    await page.click("#label");
    const want = method === "get" ? `${LANDING}?q=x` : LANDING;
    expect(await waitForUrl(() => page.evaluate("location.href") as Promise<string>, want)).toBe(
      want,
    );
  }, 60_000);
}

test("a span inside a button that prevents default does not submit", async ({ page }) => {
  await setContent(
    page,
    `<!doctype html><title>Form</title>
    <form action="${LANDING}" onsubmit="window.submitted = true"><button onclick="event.preventDefault(); document.title='HANDLED'">
      <span id="label" style="padding:20px;display:inline-block">Go</span></button></form>`,
  );
  await page.click("#label");
  const seen = await page.evaluate(
    "JSON.stringify([document.title, window.submitted === true, location.protocol])",
  );
  expect(seen).toBe(JSON.stringify(["HANDLED", false, "data:"]));
}, 60_000);
