// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// getAttribute lowercases its argument only on an HTML element. A parsed
// <svg> keeps viewBox in camel case, so getAttribute("viewBox") must find it
// in page scripts (V8) and in Runtime.evaluate (boa's DOM fast path).
// https://dom.spec.whatwg.org/#dom-element-getattribute
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<svg id="s" viewBox="0 0 10 20"></svg><div id="d" data-x="1"></div>
<script>
  (function () {
    var s = document.getElementById("s");
    var d = document.getElementById("d");
    globalThis.__caseReport = JSON.stringify({
      svg: [s.getAttribute("viewBox"), s.getAttribute("viewbox"), s.hasAttribute("viewBox"),
        s.viewBox.baseVal.width, s.viewBox.baseVal.height],
      html: [d.getAttribute("DATA-X"), d.hasAttribute("Data-X")],
    });
  })();
</script>`;

test("getAttribute keeps the case of a non-HTML element's attribute", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__caseReport")).toEqual({
    svg: ["0 0 10 20", null, true, 10, 20],
    html: ["1", true],
  });
  expect(
    await page.evaluate(() => {
      const s = document.getElementById("s")!;
      return [s.getAttribute("viewBox"), s.getAttribute("viewbox"), s.hasAttribute("viewBox")];
    }),
  ).toEqual(["0 0 10 20", null, true]);
}, 60_000);
