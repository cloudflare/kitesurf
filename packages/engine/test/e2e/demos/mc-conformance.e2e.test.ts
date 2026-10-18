// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";
import html from "../html/mc-conformance.html?raw";

test("mc-conformance", async ({ page }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });

  await page
    .waitForFunction(
      () => document.title.startsWith("MC:") || document.title.startsWith("MCERR:"),
      { timeout: 20000 },
    )
    .catch(() => {});
  const title = await page.evaluate(() => document.title);
  expect(title.startsWith("MC:"), `fixture never reported: ${title}`).toBeTruthy();
  const r = JSON.parse(title.slice("MC:".length));

  expect(r.impl, "page must use the JS shim, never native ports").toBe("shim");
  expect(r.buffering, "pre-handler posts buffer until onmessage").toBe("buffered");
  expect(r.beforeStart, "addEventListener alone must not start").toBe("null");
  expect(r.afterStart, "start() flushes the buffered message").toBe("x");
  expect(r.clone, "message is structured-cloned at post time").toBe(1);
  expect(r.fifo, "in-order single delivery").toBe("0,1,2,3,4");
  expect(r.asyncImmediate, "delivery is never synchronous").toBe(true);
  expect(r.asyncAfter, "delivery does happen asynchronously").toBe(true);
  expect(r.closeOk, "close() stops delivery").toBe(true);
  expect(r.cloneErr, "unclonable message throws").toBe("DataCloneError");
  expect(r.xferErr, "transferring the source port throws").toBe("DataCloneError");
  expect(r.addEL, "addEventListener + start() delivers").toBe("el");
  expect(r.xferRecvLen, "transferred ArrayBuffer arrives intact").toBe(8);
  expect(r.xferSrcDetached, "sender's transferred buffer detaches").toBe(true);
  expect(r.isMP, "ports are instanceof MessagePort").toBe(true);
});
