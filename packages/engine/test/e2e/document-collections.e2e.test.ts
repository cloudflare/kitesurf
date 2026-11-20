// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// A created document's images, links, forms, scripts, embeds, plugins,
// anchors and applets are live HTMLCollections, as on the live document.
// https://html.spec.whatwg.org/#dom-document-images
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { readJsonReport } from "./eval-report";

const html = `<script>
  (function () {
    var doc = document.implementation.createHTMLDocument("t");
    doc.body.innerHTML = '<img id="i"><a href="/x">x</a><a name="n">n</a><form></form><embed>';
    var images = doc.images;
    var names = ["images", "links", "forms", "scripts", "embeds", "plugins", "anchors", "applets"];
    var kinds = names.map(function (n) { return doc[n] instanceof HTMLCollection; });
    doc.body.appendChild(doc.createElement("img"));
    globalThis.__collectionsReport = JSON.stringify({
      kinds: kinds,
      lengths: names.map(function (n) { return doc[n].length; }),
      live: images.length,
      named: images.namedItem("i") === doc.getElementById("i"),
    });
  })();
</script>`;

test("a created document's collections are live HTMLCollections", async ({ page, cdpSession }) => {
  await setContent(page, html, { waitUntil: "domcontentloaded" });
  expect(await readJsonReport(cdpSession, "globalThis.__collectionsReport")).toEqual({
    kinds: [true, true, true, true, true, true, true, true],
    lengths: [2, 1, 1, 0, 1, 1, 1, 0],
    live: 2,
    named: true,
  });
}, 60_000);

const NAMES = ["a\\b", 'q"x', '\\"],*,[x="', "😀", "a\nb", "a\rb", "a\fb", "ab"];

test("getElementsByName matches the name literally", async ({ page }) => {
  await setContent(page, "<title>names</title>");
  const r = await page.evaluate((names) => {
    const lookups = (doc: Document) => {
      for (const name of names.filter((n) => !n.includes("*"))) {
        const input = doc.createElement("input");
        input.setAttribute("name", name);
        doc.body.appendChild(input);
      }
      return names.map((name) =>
        Array.from(doc.getElementsByName(name), (el) => el.getAttribute("name")),
      );
    };
    return {
      live: lookups(document),
      created: lookups(document.implementation.createHTMLDocument("t")),
    };
  }, NAMES);
  const expected = NAMES.map((name) => (name.includes("*") ? [] : [name]));
  expect(r).toEqual({ live: expected, created: expected });
});
