// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { waitForTitle } from "./waits";

test("inserted external scripts: load, error, and silent transport failure", async ({
  browser,
}) => {
  const page = (await browser.pages())[0] ?? (await browser.newPage());

  await page.goto("http://127.0.0.1:8787/__fixtures/inserted-script.html", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  const title = await waitForTitle(page, "INSERTED:", {
    prefix: true,
    timeout: 30000,
  });
  expect(
    title.startsWith("INSERTED:"),
    "fixture never reported (title=" + title + ")",
  ).toBeTruthy();

  const out = JSON.parse(title.slice("INSERTED:".length));

  expect(out.ran, "inserted script executed").toBe(true);

  expect(out.events, "events").toEqual([
    "error:/__fixtures/inserted-missing.js",
    "load:/__fixtures/inserted-ok.js",
  ]);
});

// The second src redirects to the first from another directory: the script is the response's,
// so its frames and its import() base name the URL that served it, not the one that was asked.
const BOA_STACK_SCRIPT = "/__fixtures/boa-stack/inserted.js";
const BOA_STACK_SRCS = [
  BOA_STACK_SCRIPT,
  "/__fixtures/loud-redirect?to=" + encodeURIComponent(BOA_STACK_SCRIPT),
];

for (const src of BOA_STACK_SRCS) {
  const how = src === BOA_STACK_SCRIPT ? "its URL" : "the URL it was redirected to";
  test(`a boa-run inserted script is named by ${how} in stacks and import()`, async ({ page }) => {
    const loader =
      '<script>var s = document.createElement("script");' +
      ` s.src = ${JSON.stringify(src)};` +
      ' s.onload = function () { document.title = "STACK:loaded"; };' +
      " document.head.appendChild(s);</script>";
    await page.goto(
      "http://127.0.0.1:8787/__fixtures/policy-doc.html?body=" + encodeURIComponent(loader),
      { waitUntil: "domcontentloaded", timeout: 30000 },
    );
    expect(await waitForTitle(page, "STACK:loaded", { timeout: 30000 })).toBe("STACK:loaded");
    const out = (await page.evaluate(`(async () => ({
      atLoad: window.__ksStackAtLoad,
      later: window.__ksStackLater(),
      dep: await window.__ksImportDep().then((m) => m.where, (e) => "rejected: " + e),
    }))()`)) as Record<string, string>;
    const script = `http://127.0.0.1:8787${BOA_STACK_SCRIPT}:`;
    expect(out.atLoad).toContain(script);
    expect(out.later).toContain(script);
    expect(out.dep).toBe("beside the script");
  });
}
