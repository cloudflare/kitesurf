// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

function logMessages(messages: Array<{ type: string; text: string }>): void {
  for (const message of messages) console.log("  -", message.type, "|", message.text);
}

test("page-script-demo", async ({ page }) => {
  const FIXTURE_URL =
    process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/inline-script.html";

  const messages = [];

  page.on("console", (msg) => {
    messages.push({
      type: msg.type(),
      text: msg.text(),
    });
  });

  await page.goto(FIXTURE_URL, { timeout: 15000 });

  await expect
    .poll(() => messages.length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(3)
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 50));

  console.log("[ps] captured", messages.length, "console messages:");
  logMessages(messages);

  const types = messages.map((m) => m.type);
  expect(types, "console message types").toStrictEqual(["log", "info", "warn"]);

  expect(messages[0]?.text, "message[0] greeting").toBe("hello from inline script 1");

  expect(messages[1]?.text, "message[1] reports marker=2").toContain("marker is now 2");

  expect(messages[2]?.text, "message[2] reports helper(3) = 30").toContain("helper(3) = 30");

  const marker = await page.evaluate(() => globalThis.__ks_marker);
  console.log("[ps] globalThis.__ks_marker via page.evaluate =", marker);
  expect(marker, "globalThis.__ks_marker shared with Runtime.evaluate").toBe(2);

  const h1 = await page.evaluate(() => {
    const el = document.querySelector("#hdr");
    return el ? el.textContent : null;
  });
  console.log("[ps] #hdr textContent =", JSON.stringify(h1));
  expect(h1, "#hdr textContent").toBe("kitesurf");
});
