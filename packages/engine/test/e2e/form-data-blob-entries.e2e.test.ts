// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (function () {
    var blob = new Blob(["abc"], { type: "text/plain" });
    var file = new File(["x"], "orig.txt", { type: "text/x", lastModified: 5 });
    var fd = new FormData();
    fd.append("blob", blob);
    fd.append("named", blob, "b.txt");
    fd.append("file", file);
    fd.append("renamed", file, "renamed.txt");
    fd.set("set", blob, "s.txt");
    fd.append("text", "plain");
    function describe(v) {
      return v instanceof File ? [v.name, v.type, v.size, v.lastModified === 5] : v;
    }
    var out = {};
    fd.forEach(function (v, k) { out[k] = describe(v); });
    out.sameFile = fd.get("file") === file;
    globalThis.__fdReport = JSON.stringify(out);
  })();
</script>`;

test("FormData stores Blob values as File entries", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__fdReport")).toEqual({
    blob: ["blob", "text/plain", 3, false],
    named: ["b.txt", "text/plain", 3, false],
    file: ["orig.txt", "text/x", 1, true],
    renamed: ["renamed.txt", "text/x", 1, true],
    set: ["s.txt", "text/plain", 3, false],
    text: "plain",
    sameFile: true,
  });
}, 60_000);
