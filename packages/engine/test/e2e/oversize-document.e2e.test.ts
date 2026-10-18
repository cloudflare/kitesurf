// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const ORIGIN = "https://ks.invalid/__fixtures/oversize-doc.html";

test("an announced over-cap document fails the navigation", async ({ cdpSession }) => {
  const res = (await cdpSession.send("Page.navigate", {
    url: `${ORIGIN}?declared=${64 * 1024 * 1024}`,
  })) as { errorText?: string };
  expect(res.errorText).toBe("net::ERR_FILE_TOO_BIG");
});

test("an endless document with no Content-Length aborts mid-stream", async ({ cdpSession }) => {
  const res = (await cdpSession.send("Page.navigate", {
    url: `${ORIGIN}?endless=1`,
  })) as { errorText?: string };
  expect(res.errorText).toBe("net::ERR_FILE_TOO_BIG");
}, 60_000);

test("an under-cap document still navigates", async ({ cdpSession }) => {
  const res = (await cdpSession.send("Page.navigate", {
    url: ORIGIN,
  })) as { errorText?: string };
  expect(res.errorText).toBeUndefined();
});
