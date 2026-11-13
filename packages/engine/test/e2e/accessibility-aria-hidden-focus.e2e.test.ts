// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession } from "@cloudflare/puppeteer";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// A modal rendered inside the app root, which the modal manager marks aria-hidden while its
// focus trap holds focus in the dialog.
const PAGE = `
  <div id="app" aria-hidden="true">
    <button id="outside">Outside</button>
    <div role="dialog" aria-label="Compose">
      <div id="trap" tabindex="-1">
        <input id="to" aria-label="To">
        <button id="send">Send<span aria-hidden="true"> decorative icon</span></button>
      </div>
    </div>
    <div id="host"></div>
  </div>
  <button id="elsewhere">Elsewhere</button>
  <script>
    document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
      '<button id="inner">Inner</button>';
  </script>
`;

async function exposed(session: CDPSession): Promise<{ controls: string[]; text: string }> {
  const { nodes } = await session.send("Accessibility.getFullAXTree");
  const shown = nodes.filter((n) => !n.ignored);
  return {
    controls: shown
      .filter((n) => ["button", "textbox", "dialog"].includes(String(n.role?.value)))
      .map((n) => `${String(n.role?.value)}:${String(n.name?.value ?? "")}`),
    text: shown
      .filter((n) => n.role?.value === "StaticText")
      .map((n) => String(n.name?.value ?? ""))
      .join(" "),
  };
}

test("aria-hidden does not hide the focused element or its ancestors", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, PAGE);
  await cdpSession.send("Accessibility.enable");
  const hiddenApp = ["button:Elsewhere"];
  const shownApp = [
    "button:Outside",
    "dialog:Compose",
    "textbox:To",
    "button:Send",
    "button:Inner",
    "button:Elsewhere",
  ];

  expect((await exposed(cdpSession)).controls).toEqual(hiddenApp);

  await page.evaluate(() => document.querySelector<HTMLElement>("#trap")?.focus());
  const trapped = await exposed(cdpSession);
  expect(trapped.controls).toEqual(shownApp);
  expect(trapped.text).not.toContain("decorative icon");

  // The mark is discarded for good, as in Chrome: a tree that flipped back when focus left
  // would hide controls the client had already been shown.
  await page.evaluate(() => document.querySelector<HTMLElement>("#elsewhere")?.focus());
  expect((await exposed(cdpSession)).controls).toEqual(shownApp);

  // A new document starts with its marks intact, so the discard does not outlive the page
  // that earned it; focus inside a shadow tree counts for its host's ancestors too.
  await setContent(page, PAGE);
  expect((await exposed(cdpSession)).controls).toEqual(hiddenApp);
  await page.evaluate(() =>
    document.querySelector("#host")?.shadowRoot?.querySelector<HTMLElement>("#inner")?.focus(),
  );
  expect((await exposed(cdpSession)).controls).toEqual(shownApp);
}, 120_000);
