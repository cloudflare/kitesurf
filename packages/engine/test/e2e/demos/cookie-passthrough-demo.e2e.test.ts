// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

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

  expect(
    !!seen.doc?.cookie,
    "doc fetch saw cookie header: doc.headers=" + JSON.stringify(seen.doc),
  ).toBeTruthy();
  if (seen.doc?.cookie) {
    expect(
      seen.doc.cookie.includes("ks_demo_session=abc123"),
      "doc fetch cookie contains ks_demo_session: " + seen.doc.cookie,
    ).toBeTruthy();
    expect(
      seen.doc.cookie.includes("ks_demo_lax=lax_value"),
      "doc fetch cookie contains ks_demo_lax: " + seen.doc.cookie,
    ).toBeTruthy();
  }
  expect(
    !!seen.fetch?.cookie,
    "subresource fetch saw cookie header: fetch.headers=" + JSON.stringify(seen.fetch),
  ).toBeTruthy();
  if (seen.fetch?.cookie) {
    expect(
      seen.fetch.cookie.includes("ks_demo_session=abc123"),
      "subresource fetch cookie contains ks_demo_session: " + seen.fetch.cookie,
    ).toBeTruthy();
    expect(
      seen.fetch.cookie.includes("ks_demo_lax=lax_value"),
      "subresource fetch cookie contains ks_demo_lax: " + seen.fetch.cookie,
    ).toBeTruthy();
  }
});
