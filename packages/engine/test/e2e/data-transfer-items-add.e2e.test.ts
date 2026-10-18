// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Pins `DataTransferItemList.add` overload selection and WebIDL argument conversion.
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (function () {
    var dt = new DataTransfer();
    var file = new File(["x"], "a.txt", { type: "text/plain" });
    dt.items.add("text", "text/plain");
    dt.items.add(file);
    dt.items.add(file, "text/x-file");
    var thrown = [];
    ["text", {}, null, 1].forEach(function (value) {
      try { dt.items.add(value); thrown.push("none"); } catch (e) { thrown.push(e.name); }
    });
    globalThis.__addReport = JSON.stringify({
      thrown: thrown,
      length: dt.items.length,
      items: Array.from(dt.items, function (item) { return [item.kind, item.type]; }),
      files: Array.from(dt.files, function (file) { return file instanceof File && file.name; }),
    });
  })();
</script>`;

test("DataTransferItemList.add picks its overload by argument count", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__addReport")).toEqual({
    thrown: ["TypeError", "TypeError", "TypeError", "TypeError"],
    length: 3,
    items: [
      ["string", "text/plain"],
      ["file", "text/plain"],
      ["string", "text/x-file"],
    ],
    files: ["a.txt"],
  });
}, 60_000);
