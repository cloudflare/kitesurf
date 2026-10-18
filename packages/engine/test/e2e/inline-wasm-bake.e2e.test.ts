// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { waitForTitle } from "./waits";

test("inline base64 wasm is discovered and baked", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  await page.goto("http://127.0.0.1:8787/__fixtures/inline-wasm.html", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const title = await waitForTitle(page, "INLINEWASM:", {
    prefix: true,
    timeout: 20000,
  });
  expect(
    title.startsWith("INLINEWASM:"),
    "fixture never reported (title=" + title + ")",
  ).toBeTruthy();

  const out = JSON.parse(title.slice("INLINEWASM:".length));
  expect(out.instantiate, "instantiate(bytes).instance.exports.add").toBe(42);
  expect(out.hasModule, "instantiate(bytes).module").toBe(true);
  expect(out.compile, "compile(bytes) + new Instance").toBe(5);

  expect(
    consoleErrors.filter((t) => t.includes("Wasm code generation disallowed")),
    "CompileError leaked to console",
  ).toStrictEqual([]);
});
