// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// <dialog> must expose show/showModal/close/requestClose and returnValue.
// show() and showModal() are idempotent per modal state and throw only on the
// mixed cases; the close event is queued as a task.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (function () {
    var out = { methods: [], cases: { closeEvents: 0 } };
    function mk() {
      var d = document.createElement("dialog");
      document.body.appendChild(d);
      return d;
    }
    var d1 = mk();
    d1.show();
    try { d1.show(); out.cases.showTwice = "ok"; } catch (e) { out.cases.showTwice = e.name; }
    var d2 = mk();
    d2.showModal();
    try { d2.showModal(); out.cases.showModalTwice = "ok"; } catch (e) { out.cases.showModalTwice = e.name; }
    var d3 = mk();
    d3.showModal();
    try { d3.show(); out.cases.showOnModal = "ok"; } catch (e) { out.cases.showOnModal = e.name; }
    var d4 = mk();
    d4.show();
    try { d4.showModal(); out.cases.showModalOnNonModal = "ok"; } catch (e) { out.cases.showModalOnNonModal = e.name; }

    var d5 = mk();
    out.methods = [typeof d5.show, typeof d5.showModal, typeof d5.close, typeof d5.requestClose];
    d5.show();
    d5.addEventListener("close", function () {
      out.cases.closeEvents += 1;
      out.cases.afterClose = d5.open;
      out.cases.returnValue = d5.returnValue;
      globalThis.__dialogReport = JSON.stringify(out);
    });
    d5.close("done");
    out.cases.closeSync = out.cases.closeEvents;
  })();
</script>`;

test("dialog methods follow the show/showModal state machine", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => (globalThis as { __dialogReport?: string }).__dialogReport !== undefined,
    { timeout: 20_000 },
  );
  expect(await readJsonReport(cdpSession, "globalThis.__dialogReport")).toEqual({
    methods: ["function", "function", "function", "function"],
    cases: {
      showTwice: "ok",
      showModalTwice: "ok",
      showOnModal: "InvalidStateError",
      showModalOnNonModal: "InvalidStateError",
      closeEvents: 1,
      afterClose: false,
      returnValue: "done",
      closeSync: 0,
    },
  });
}, 60_000);
