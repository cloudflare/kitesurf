// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchReference, inventoryFromManifest, referenceSubtests } from "./wpt-inventory.mjs";

const manifest = {
  version: 9,
  url_base: "/",
  items: {
    testharness: {
      dom: {
        "a.html": ["h1", [null, {}]],
        "b.any.js": ["h2", ["dom/b.any.html", {}], ["dom/b.any.worker.html", {}]],
      },
    },
    reftest: {
      css: { x: { "r.html": ["h3", ["css/x/r.html?v=1", [["/css/x/r-ref.html", "=="]], {}]] } },
    },
    manual: { dom: { "m-manual.html": ["h4", [null, {}]] } },
    support: { dom: { "helper.js": ["h5", [null, {}]] } },
    test262: { js: { "t.js": ["h6", [null, {}]] } },
  },
};

test("lists every automatable URL, expanded and sorted", () => {
  const { types, tests } = inventoryFromManifest(manifest);
  assert.deepEqual(tests, [
    "/css/x/r.html?v=1",
    "/dom/a.html",
    "/dom/b.any.html",
    "/dom/b.any.worker.html",
  ]);
  assert.deepEqual(types, { testharness: 3, reftest: 1, "print-reftest": 0, crashtest: 0 });
});

test("refuses a manifest version it doesn't know", () => {
  assert.throws(() => inventoryFromManifest({ ...manifest, version: 8 }), /version 8/);
});

test("takes each inventory test's subtest total from the summary", () => {
  const summary = {
    "/dom/a.html": { s: "O", c: [3, 5] },
    "/css/x/r.html?v=1": { s: "P", c: [1, 1] },
    "/dom/not-in-inventory.html": { s: "O", c: [1, 9] },
    "/dom/b.any.html": { s: "E" },
    // A reftest or crashtest: no subtests, so wpt.fyi reports [0, 0].
    "/dom/crashtests/c.html": { s: "P", c: [0, 0] },
  };
  const tests = [
    "/css/x/r.html?v=1",
    "/dom/a.html",
    "/dom/b.any.html",
    "/dom/crashtests/c.html",
    "/dom/gone.html",
  ];
  assert.deepEqual(referenceSubtests(summary, tests), {
    "/css/x/r.html?v=1": 1,
    "/dom/a.html": 5,
    "/dom/crashtests/c.html": 1,
  });
});

test("reads the Chrome run at the revision, and null when wpt.fyi has none", async () => {
  /** @type {string[]} */
  const asked = [];
  /** @param {Record<string, unknown>} bodies */
  const fakeFetch = (bodies) => async (/** @type {string} */ url) => {
    asked.push(url);
    return Response.json(bodies[url.startsWith("https://wpt.fyi/") ? "runs" : url]);
  };
  const run = {
    id: 7,
    browser_name: "chrome",
    browser_version: "154.0",
    results_url: "https://store/summary.json",
  };
  const reference = await fetchReference(
    "abc123",
    ["/dom/a.html"],
    fakeFetch({
      runs: [run],
      "https://store/summary.json": { "/dom/a.html": { s: "O", c: [2, 4] } },
    }),
  );
  assert.deepEqual(reference, {
    runId: 7,
    browser: "chrome",
    version: "154.0",
    subtests: { "/dom/a.html": 4 },
  });
  assert.equal(asked[0], "https://wpt.fyi/api/runs?product=chrome&sha=abc123&label=master");
  assert.equal(await fetchReference("abc123", [], fakeFetch({ runs: [] })), null);
});
