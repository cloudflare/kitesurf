// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const reply = { frameId: expect.any(String), loaderId: expect.any(String), isDownload: false };

test("Page.navigate replies with Chrome's keys, isDownload included", async ({
  cdpSession: cdp,
}) => {
  const loaded = await cdp.send("Page.navigate", { url: "data:text/html,<p>loaded</p>" });
  expect(loaded).toStrictEqual(reply);
  expect(await cdp.send("Page.navigate", { url: "about:blank" })).toStrictEqual(reply);
  const noContent = await cdp.send("Page.navigate", {
    url: "https://ks.invalid/__fixtures/status-204",
  });
  expect(noContent).toStrictEqual({ ...reply, errorText: "net::ERR_ABORTED" });
}, 60_000);
