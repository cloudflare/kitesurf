// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// <dialog> must expose show/showModal/close/requestClose and returnValue.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (function () {
    var d = document.createElement("dialog");
    document.body.appendChild(d);
    var out = {
      methods: [typeof d.show, typeof d.showModal, typeof d.close, typeof d.requestClose],
      before: d.open,
      afterShow: null,
      afterClose: null,
      returnValue: null,
      closeEvents: 0,
    };
    d.addEventListener("close", function () { out.closeEvents += 1; });
    d.showModal();
    out.afterShow = d.open;
    d.close("done");
    out.afterClose = d.open;
    out.returnValue = d.returnValue;
    globalThis.__dialogReport = JSON.stringify(out);
  })();
</script>`;

test("dialog methods open, close, and report returnValue", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__dialogReport")).toEqual({
    methods: ["function", "function", "function", "function"],
    before: false,
    afterShow: true,
    afterClose: false,
    returnValue: "done",
    closeEvents: 1,
  });
}, 60_000);
