// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { waitForTitle } from "../waits";

const EXPECTED = {
  probe: "true",
  streaming: "5",
  streamingModule: "true",
  bytes: "42",
  compile: "true",
  syncModule: "2",
};

test("wasm-bake-demo", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  await page.goto("http://127.0.0.1:8787/__fixtures/wasm-boot.html", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const title = await waitForTitle(page, "WASMBOOT:", {
    prefix: true,
    timeout: 20000,
  });
  expect(
    title.startsWith("WASMBOOT:"),
    "fixture never reported (title=" + title + ")",
  ).toBeTruthy();

  const actual = JSON.parse(title.slice("WASMBOOT:".length));
  for (const [k, want] of Object.entries(EXPECTED)) {
    expect(actual[k], k).toStrictEqual(want);
  }

  const leaked = consoleErrors.filter((t) => t.includes("Wasm code generation disallowed"));
  expect(leaked, "CompileError leaked to console").toStrictEqual([]);
});
