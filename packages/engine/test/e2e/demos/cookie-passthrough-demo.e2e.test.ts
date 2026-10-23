// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

function expectDemoCookies(
  headers: { cookie?: string } | null,
  source: "doc" | "subresource",
): void {
  const cookie = headers?.cookie;
  const description = source === "doc" ? "doc fetch" : "subresource fetch";
  const headerName = source === "doc" ? "doc" : "fetch";
  expect(
    !!cookie,
    `${description} saw cookie header: ${headerName}.headers=${JSON.stringify(headers)}`,
  ).toBeTruthy();
  if (!cookie) return;
  expect(
    cookie.includes("ks_demo_session=abc123"),
    `${description} cookie contains ks_demo_session: ${cookie}`,
  ).toBeTruthy();
  expect(
    cookie.includes("ks_demo_lax=lax_value"),
    `${description} cookie contains ks_demo_lax: ${cookie}`,
  ).toBeTruthy();
}

test("cookie-passthrough-demo", async ({ page }) => {
  const session = await page.target().createCDPSession();

  await session.send("Network.setCookies", {
    cookies: [
      {
        name: "ks_demo_session",
        value: "abc123",
        url: "http://127.0.0.1:8787/",
        path: "/",
      },
      {
        name: "ks_demo_lax",
        value: "lax_value",
        url: "http://127.0.0.1:8787/",
        path: "/",
        sameSite: "Lax",
      },
    ],
  });

  await session.send("Page.navigate", {
    url: "http://127.0.0.1:8787/__fixtures/echo-headers.html",
  });
  await page.evaluate(
    () => (globalThis as { __ks_fetch_ready?: Promise<unknown> }).__ks_fetch_ready,
  );

  const seen = await page.evaluate(() => ({
    doc: globalThis.__ks_doc_headers || null,
    fetch: globalThis.__ks_fetch_headers || null,
  }));

  expectDemoCookies(seen.doc, "doc");
  expectDemoCookies(seen.fetch, "subresource");
});
