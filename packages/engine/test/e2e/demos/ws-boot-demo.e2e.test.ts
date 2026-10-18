// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { waitForTitle } from "../waits";

test("ws-boot-demo", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/ws-boot.html", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const title = await waitForTitle(page, "WSBOOT:", {
    prefix: true,
    timeout: 25000,
  });
  expect(title.startsWith("WSBOOT:"), "fixture never reported (title=" + title + ")").toBeTruthy();

  const out = JSON.parse(title.slice("WSBOOT:".length));
  expect(out.timeout, "socket lifecycle completed").toBeUndefined();
  expect(out.ctorState, "CONNECTING at construct").toBe(0);
  expect(out.constants, "readyState constants").toBe("0,1,2,3");
  expect(out.openState, "OPEN in onopen").toBe(1);
  expect(out.events.join(","), "event order").toBe("open,text,bin,close");
  expect(out.text, "text echo").toBe("echo:hello");
  expect(out.bin, "binary echo (view slice 1..5)").toBe("1,2,3,250");
  expect(out.code, "server close code").toBe(4001);
  expect(out.reason, "server close reason").toBe("bye");
  expect(out.closedState, "CLOSED in onclose").toBe(3);
});
