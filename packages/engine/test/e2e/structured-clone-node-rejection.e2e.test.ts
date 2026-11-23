// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// structuredClone rejects a node with DataCloneError, and still clones the
// types it accepts. A page that wraps a node in a plain object must see the
// same rejection.
// https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializeinternal
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<!doctype html><html><body><div id="d"><span>x</span></div>
<script>
  function outcome(fn) {
    try {
      return "ok:" + fn();
    } catch (e) {
      return "throw:" + e.name;
    }
  }
  globalThis.__clone = JSON.stringify({
    body: outcome(function () { return structuredClone(document.body); }),
    element: outcome(function () { return structuredClone(document.getElementById("d")); }),
    nested: outcome(function () { return structuredClone({ node: document.getElementById("d") }); }),
    array: outcome(function () { return structuredClone([document.body]); }),
    map: outcome(function () { return structuredClone(new Map([["a", 1]])).get("a"); }),
    plain: outcome(function () { return structuredClone({ a: [1, 2] }).a[1]; }),
  });
</script></body></html>`;

test("structuredClone rejects nodes and keeps cloning plain values", async ({
  page,
  cdpSession,
}) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__clone")).toEqual({
    body: "throw:DataCloneError",
    element: "throw:DataCloneError",
    nested: "throw:DataCloneError",
    array: "throw:DataCloneError",
    map: "ok:1",
    plain: "ok:2",
  });
}, 60_000);
