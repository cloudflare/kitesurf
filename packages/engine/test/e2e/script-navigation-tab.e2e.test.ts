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

test("location.replace navigates the tab whose script called it", async ({ browser }) => {
  const first = (await browser.pages())[0] ?? (await browser.newPage());
  const second = await browser.newPage();
  await second.goto("http://127.0.0.1:8787/__fixtures/navigation-reloading.html", {
    waitUntil: "load",
  });
  const href = () => second.evaluate("location.href") as Promise<string>;
  expect(await waitForUrl(href, LANDING)).toBe(LANDING);
  expect(await second.evaluate("document.querySelector('button')?.textContent ?? ''")).toBe(
    "Continue",
  );
  expect(await first.evaluate("location.href")).not.toBe(LANDING);
}, 120_000);

test("a script form.submit() navigates the tab that submitted it", async ({ browser }) => {
  const first = (await browser.pages())[0] ?? (await browser.newPage());
  const second = await browser.newPage();
  await setContent(
    second,
    `<!doctype html><title>Form</title>
    <form action="${LANDING}" method="get"><input name="q" value="x"></form>
    <script>setTimeout(() => document.forms[0].submit(), 300);</script>`,
  );
  const href = () => second.evaluate("location.href") as Promise<string>;
  expect(await waitForUrl(href, `${LANDING}?q=x`)).toBe(`${LANDING}?q=x`);
  expect(await second.evaluate("document.querySelector('button')?.textContent ?? ''")).toBe(
    "Continue",
  );
  expect(await first.evaluate("location.href")).not.toContain("navigation-landing");
}, 120_000);
