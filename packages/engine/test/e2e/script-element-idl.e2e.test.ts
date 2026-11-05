// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Consent blockers wrap document.createElement and route a new script's src and type through
// the descriptors they read off HTMLScriptElement.prototype; every later tag depends on them.
import { expect, test } from "./harness";

const ORIGIN = "https://ks.invalid";

const docUrl = (body: string): string => {
  const u = new URL(`${ORIGIN}/__fixtures/policy-doc.html`);
  u.searchParams.set("body", body);
  return u.toString();
};

const WRAPPER = `
var own = {
  src: Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src"),
  type: Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "type")
};
var create = document.createElement;
document.createElement = function (tag) {
  var el = create.apply(document, arguments);
  if (String(tag).toLowerCase() !== "script") return el;
  Object.defineProperties(el, {
    src: { get: function () { return own.src.get.call(this); }, set: function (v) { own.src.set.call(this, v); } },
    type: { get: function () { return own.type.get.call(this); }, set: function (v) { own.type.set.call(this, v); } }
  });
  return el;
};
var s = document.createElement("script");
s.src = ${JSON.stringify(`${ORIGIN}/__fixtures/policy-script.js?tag=wrapped`)};
s.onload = function () { window.__outcome = "load:" + (window.__ksRan || []).join(); };
s.onerror = function () { window.__outcome = "error"; };
document.head.appendChild(s);
`;

test("a script inserted through a consent-style createElement wrapper still loads", async ({
  page,
}) => {
  // The wrapper runs from an inserted script, the way a consent tag loads.
  const body = `<script>
    var w = document.createElement("script");
    w.textContent = ${JSON.stringify(WRAPPER)};
    document.head.appendChild(w);
  </script>`;
  await page.goto(docUrl(body), { waitUntil: "load" });
  await page.waitForFunction(
    () => typeof (globalThis as { __outcome?: string }).__outcome === "string",
    { timeout: 20_000 },
  );
  expect(await page.evaluate(() => (globalThis as { __outcome?: string }).__outcome)).toBe(
    "load:wrapped",
  );
}, 60_000);

test("src, type and async are own accessors, and async follows force async", async ({ page }) => {
  const body = `<script id="p"></script><script id="pa" async src="${ORIGIN}/__fixtures/policy-script.js?tag=pa"></script>
  <script>
    var own = function (proto, name) {
      var d = Object.getOwnPropertyDescriptor(proto, name);
      return !!(d && d.get && d.set);
    };
    var created = document.createElement("script");
    var cleared = document.createElement("script");
    cleared.async = false;
    var added = document.createElement("script");
    added.setAttribute("async", "");
    added.removeAttribute("async");
    window.__result = {
      own: [
        own(HTMLScriptElement.prototype, "src"),
        own(HTMLScriptElement.prototype, "type"),
        own(HTMLScriptElement.prototype, "async"),
        own(HTMLImageElement.prototype, "src"),
        own(HTMLIFrameElement.prototype, "src")
      ],
      async: [
        document.getElementById("p").async,
        document.getElementById("pa").async,
        created.async,
        cleared.async,
        cleared.hasAttribute("async"),
        added.async
      ]
    };
  </script>`;
  await page.goto(docUrl(body), { waitUntil: "load" });
  expect(await page.evaluate(() => (globalThis as { __result?: unknown }).__result)).toEqual({
    own: [true, true, true, true, true],
    async: [false, true, true, false, false, false],
  });
}, 60_000);
