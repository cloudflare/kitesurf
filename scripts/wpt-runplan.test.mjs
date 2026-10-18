// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { EXPECT_FILE } from "./wpt-shared.mjs";
import { project } from "./wpt-runplan.mjs";

const expectations = {
  "/a.html": { expected: "PASS", reason: null },
  "/b.html": { expected: "FAIL", reason: "stylo" },
  "/c.html": { expected: "TIMEOUT", reason: null, timeout: 60000 },
  "/d.html": { expected: "CRASH", reason: "oom" },
  "/e.html": { expected: "FAIL", timeout: 20000, subtestSlack: 2 },
  "/f.html": { expected: "SKIP" },
  "/g.html": { expected: "ERROR", acceptedRegression: true },
  "/h.html": { expected: "PASS", slow: true },
};

test("keeps only run-affecting expectation fields", () => {
  assert.deepEqual(project(expectations, Object.keys(expectations)), {
    "/c.html": { expected: "TIMEOUT", timeout: 60000 },
    "/d.html": { expected: "CRASH" },
    "/e.html": { timeout: 20000 },
    "/f.html": { expected: "SKIP" },
    "/g.html": { expected: "ERROR" },
    "/h.html": { slow: true },
  });
});

test("projects only bucket tests in a stable order", () => {
  assert.deepEqual(
    Object.keys(project(expectations, ["/f.html", "/a.html", "/c.html", "/missing.html"])),
    ["/c.html", "/f.html"],
  );
});

test("a PASS or FAIL rebaseline leaves the projection unchanged", () => {
  const next = {
    ...expectations,
    "/a.html": { expected: "FAIL" },
    "/b.html": { expected: "PASS" },
  };
  assert.equal(
    JSON.stringify(project(next, Object.keys(expectations))),
    JSON.stringify(project(expectations, Object.keys(expectations))),
  );
});

test("the checked-in expectations have a selective run projection", () => {
  const actual = JSON.parse(readFileSync(EXPECT_FILE, "utf8"));
  const kept = Object.keys(project(actual, Object.keys(actual))).length;
  assert.ok(
    kept > 0 && kept < Object.keys(actual).length / 2,
    `${kept} of ${Object.keys(actual).length} kept`,
  );
});
