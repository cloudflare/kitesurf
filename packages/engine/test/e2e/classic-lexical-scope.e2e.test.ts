// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Top-level let/const/class live in one global lexical scope shared by later
// classic scripts, and are not properties of window.
// https://html.spec.whatwg.org/multipage/webappapis.html#run-a-classic-script
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  let ready = false;
  const config = { answer: 42 };
  class Widget { constructor() { this.tag = "w"; } }
  function init() { ready = true; }
</script>
<script>
  init();
  globalThis.__lexicalReport = JSON.stringify({
    ready: ready,
    answer: config.answer,
    widget: typeof Widget,
    instance: new Widget().tag,
  });
</script>`;

test("later scripts share top-level lexical bindings", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__lexicalReport")).toEqual({
    ready: true,
    answer: 42,
    widget: "function",
    instance: "w",
  });
}, 60_000);
