// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

declare global {
  interface Window {
    __control_ran?: boolean;
    __offending_started?: boolean;
    __offending_fetched_text?: string;
    __offending_completed?: boolean;
  }
}

test("top-level-await-fetch-probe", async ({ page }) => {
  const CONTROL_MODULE = `
  const el = document.getElementById("control");
  if (el) el.textContent = "control-ran";
  window.__control_ran = true;
`;

  const OFFENDING_MODULE = `
  window.__offending_started = true;
  const r = await fetch("data:text/plain,hello-from-tla");
  const text = await r.text();
  window.__offending_fetched_text = text;
  const el = document.getElementById("offending");
  if (el) el.textContent = "offending-ran:" + text;
  window.__offending_completed = true;
`;

  const HTML = `<!doctype html><html><body>
  <div id="control">control-init</div>
  <div id="offending">offending-init</div>
  <script type="module">${CONTROL_MODULE}</script>
  <script type="module">${OFFENDING_MODULE}</script>
</body></html>`;

  const pageErrors = [];
  const consoleErrors = [];

  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  const dataUrl = "data:text/html;base64," + Buffer.from(HTML).toString("base64");
  await page
    .goto(dataUrl, { timeout: 10_000 })
    .catch((e) => console.error(`[tla-probe] goto threw: ${e.message}`));

  await page
    .waitForFunction(() => window.__offending_completed === true, {
      timeout: 15_000,
    })
    .catch(() => {});

  const state = await page.evaluate(() => ({
    control_ran: window.__control_ran === true,
    control_text: document.getElementById("control")?.textContent,
    offending_started: window.__offending_started === true,
    offending_fetched_text: window.__offending_fetched_text ?? null,
    offending_completed: window.__offending_completed === true,
    offending_text: document.getElementById("offending")?.textContent,
  }));

  console.log("[tla-probe] state:", JSON.stringify(state, null, 2));
  console.log("[tla-probe] pageerrors:", pageErrors.length ? pageErrors : "(none)");
  console.log("[tla-probe] console.error:", consoleErrors.length ? consoleErrors : "(none)");

  expect(
    state.control_ran === true,
    "control inline module ran (sibling not affected)",
  ).toBeTruthy();
  expect(state.control_text, "control mutated its DOM node").toBe("control-ran");
  expect(
    state.offending_started === true,
    "offending module STARTED (sync prelude ran before await)",
  ).toBeTruthy();

  expect(state.offending_fetched_text, "side-effect: fetch resolved with real bytes").toBe(
    "hello-from-tla",
  );
  expect(state.offending_text, "side-effect: DOM mutation after await landed").toBe(
    "offending-ran:hello-from-tla",
  );
  expect(
    state.offending_completed === true,
    "side-effect: module reached the final statement",
  ).toBeTruthy();

  const sawTlaPageError = /Top-level await in module is unsettled/i.test(pageErrors.join("\n"));
  const sawWrapperConsoleError = /\[kitesurf\] user module .* threw/i.test(
    consoleErrors.join("\n"),
  );

  expect(!sawTlaPageError, "[fixed] NO 'Top-level await unsettled' page error").toBeTruthy();
  expect(
    !sawWrapperConsoleError,
    "[fixed] NO '[kitesurf] user module N threw' console.error",
  ).toBeTruthy();
});
