// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { waitForTitle } from "../waits";

test("xhr-boot-demo", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/xhr-boot.html", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const title = await waitForTitle(page, "XHRBOOT:", {
    prefix: true,
    timeout: 20000,
  });
  expect(title.startsWith("XHRBOOT:"), "fixture never reported (title=" + title + ")").toBeTruthy();

  const out = JSON.parse(title.slice("XHRBOOT:".length));
  expect(out.text, "responseText").toBe("kitesurf-xhr-ok");
  expect(out.status, "status").toBe(200);
  expect(out.ctype, "content-type readback").toBe(true);
  expect(out.responseUrlOk, "responseURL").toBe(true);
  expect(out.allHeadersOk, "getAllResponseHeaders").toBe(true);
  expect(out.events.join(","), "event order").toBe("loadstart,sent,rsc2,rsc3,rsc4,load,loadend");
  expect(out.abStatus, "arraybuffer status").toBe(200);
  expect(out.abLen, "arraybuffer byteLength (add.wasm)").toBe(41);
  expect(out.rtGuard, "responseText guard").toBe("InvalidStateError");
  expect(out.notFoundViaLoad, "404 fires load, not error").toBe(true);
  expect(out.notFoundStatus, "404 status").toBe(404);
});
