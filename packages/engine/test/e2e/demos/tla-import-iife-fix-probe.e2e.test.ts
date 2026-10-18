// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("tla-import-iife-fix-probe", async ({ page }) => {
  const BASE = process.env.KITESURF_BASE ?? "http://127.0.0.1:8787";

  async function runFixture(page, path, prefix, tag) {
    const pageErrors = [];
    const consoleErrors = [];
    const onErr = (e) => pageErrors.push(e.message);
    const onMsg = (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    };
    page.on("pageerror", onErr);
    page.on("console", onMsg);

    await page
      .goto(BASE + path, { timeout: 10_000 })
      .catch((e) => console.error(`[tla-import-probe] goto ${path} threw: ${e.message}`));
    const donePrefix = tag + "-done:";
    await page
      .waitForFunction(
        (want) => (document.getElementById("status")?.textContent ?? "").startsWith(want),
        { timeout: 15_000 },
        donePrefix,
      )
      .catch(() => {});

    const state = await page.evaluate(
      (p) => ({
        helper_loaded: window[p + "_helper_loaded"] === true,
        greeting: window[p + "_greeting"] ?? null,
        started: window[p + "_started"] === true,
        fetched_bytes: window[p + "_fetched_bytes"] ?? null,
        completed: window[p + "_completed"] === true,
        status_text: document.getElementById("status")?.textContent ?? null,
      }),
      prefix,
    );

    page.off("pageerror", onErr);
    page.off("console", onMsg);
    return { state, pageErrors, consoleErrors };
  }

  const cases = [
    {
      label: "RAW (browser source, engine wraps at bake)",
      path: "/__fixtures/tla-import-bug.html",
      prefix: "__bug",
      greetingTag: "bug",
      statusRe: /^bug-done:hello-from-helper:bug:\d+$/,
    },
    {
      label: "PREWRAPPED (hand-rolled IIFE, control)",
      path: "/__fixtures/tla-import-fix.html",
      prefix: "__fix",
      greetingTag: "fix",
      statusRe: /^fix-done:hello-from-helper:fix:\d+$/,
    },
  ];

  for (const c of cases) {
    console.log("\n[tla-import-probe] === " + c.label + " ===");
    const r = await runFixture(page, c.path, c.prefix, c.greetingTag);
    console.log("[tla-import-probe] state:", JSON.stringify(r.state, null, 2));
    console.log("[tla-import-probe] pageerrors:", r.pageErrors.length ? r.pageErrors : "(none)");
    console.log(
      "[tla-import-probe] console.error:",
      r.consoleErrors.length ? r.consoleErrors : "(none)",
    );

    expect(
      r.state.helper_loaded === true,
      c.label + ": imported HELPER_LOADED true inside IIFE",
    ).toBeTruthy();
    expect(
      r.state.greeting,
      c.label + ": imported greet() callable (ESM live binding survived)",
    ).toBe("hello-from-helper:" + c.greetingTag);
    expect(
      r.state.completed === true && r.state.fetched_bytes > 0,
      c.label + ": side-effects landed past the await",
    ).toBeTruthy();
    expect(
      c.statusRe.test(r.state.status_text ?? ""),
      c.label + ": DOM mutation post-await landed",
    ).toBeTruthy();
    const sawTla = /Top-level await in module is unsettled/i.test(r.pageErrors.join("\n"));
    const sawWrapped = /\[kitesurf\] user module .* threw/i.test(r.consoleErrors.join("\n"));
    expect(!sawTla, c.label + ": NO 'Top-level await unsettled' page error").toBeTruthy();
    expect(
      !sawWrapped,
      c.label + ": NO '[kitesurf] user module N threw' console.error",
    ).toBeTruthy();
  }
});
