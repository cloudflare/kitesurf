// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { coverageGaps, deviations, rebaseline, reportResults } from "./pw-shared.mjs";
import { junit } from "./pw-gate.mjs";

const specs = [
  { file: "a.spec.ts", only: null },
  { file: "b.spec.ts", only: ["kept"] },
  { file: "c.spec.ts", only: null },
];
const results = { "a.spec.ts::x": "PASS", "a.spec.ts::y": "FAIL", "b.spec.ts::kept": "PASS" };
const expectations = {
  "a.spec.ts::y": { expected: "FAIL" },
  "a.spec.ts::gone": { expected: "TIMEOUT" },
  "a.spec.ts::flaky": { expected: "SKIP" },
  "b.spec.ts::other": { expected: "FAIL" },
  "b.spec.ts::kept": { expected: "FAIL" },
};

test("a missing entry expects PASS", () => {
  assert.deepEqual(deviations(results, expectations), [
    { id: "b.spec.ts::kept", expected: "FAIL", actual: "PASS" },
  ]);
});

test("coverage identifies empty specs and vanished pins", () => {
  assert.deepEqual(coverageGaps(results, specs, expectations), {
    emptyFiles: ["c.spec.ts"],
    missingPins: ["a.spec.ts::gone"],
  });
});

test("report ids follow each test's describe path, not the file suite", () => {
  const spec = (title, status) => ({
    title,
    file: "a.spec.ts",
    tests: [{ results: status ? [{ status }] : [] }],
  });
  const report = {
    suites: [
      {
        title: "a.spec.ts",
        specs: [spec("top", "passed")],
        suites: [
          {
            title: "outer",
            specs: [spec("same", "failed")],
            suites: [{ title: "inner", specs: [spec("same", "timedOut"), spec("idle")] }],
          },
          { title: "", specs: [spec("anonymous", "skipped")] },
        ],
      },
    ],
  };
  assert.deepEqual(reportResults(report), {
    "a.spec.ts::top": "PASS",
    "a.spec.ts::outer › same": "FAIL",
    "a.spec.ts::outer › inner › same": "TIMEOUT",
    "a.spec.ts::outer › inner › idle": "SKIP",
    "a.spec.ts::anonymous": "SKIP",
  });
});

test("rebaseline removes passing pins and sorts the output", () => {
  const next = rebaseline({ "z::t": { expected: "FAIL" }, "m::t": { expected: "PASS" } }, [
    { id: "z::t", actual: "PASS" },
    { id: "b::t", actual: "TIMEOUT" },
  ]);
  assert.deepEqual(Object.keys(next), ["b::t", "m::t"]);
  assert.equal(next["b::t"].expected, "TIMEOUT");
});

test("JUnit includes deviations and specs that no spec action ran", () => {
  const xml = junit(results, deviations(results, expectations), ["c.spec.ts"], [], ["c.spec.ts"]);
  assert.match(xml, /<testsuite name="playwright" tests="4" failures="2">/);
  assert.match(
    xml,
    /classname="pw\.b\.spec\.ts" name="kept"><failure message="expected FAIL, got PASS"/,
  );
  assert.match(xml, /name="\(spec file\)"><failure message="no spec action ran it"/);
});
