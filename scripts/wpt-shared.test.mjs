// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  EXPECT_FILE,
  rebaseline,
  reclassifiedErrors,
  referenceUrlForVariant,
  stringifyAsciiJSON,
} from "./wpt-shared.mjs";

const SHA = "e4e35dbe32bfc81c248428e5e91a5a321b54f67c";
const marked = (reclassified, expected = "FAIL") => ({
  "/t.html": { expected, reason: "why", reclassified },
});

test("referenceUrlForVariant appends the test's variant as the WPT manifest does", () => {
  const ref = "http://web-platform.test:8000/css/x/render-ref.html";
  assert.equal(referenceUrlForVariant(ref, "/css/x/render.html"), ref);
  assert.equal(referenceUrlForVariant(ref, "/css/x/render.html?a=1&b=2"), `${ref}?a=1&b=2`);
  assert.equal(referenceUrlForVariant(ref, "/css/x/render.html#frag"), `${ref}#frag`);
  assert.equal(referenceUrlForVariant(ref, "/css/x/render.html?a#b"), `${ref}?a#b`);
});

test("stringifyAsciiJSON escapes every non-ASCII code unit and round-trips", () => {
  const value = {
    "/a.html": { expected: "FAIL", reason: "stylo — see §17 → fixed… 🤖" },
    "/b.html": { expected: "PASS", reason: null, timeout: 15000 },
  };
  const text = stringifyAsciiJSON(value);
  assert.doesNotMatch(text, /[^\x00-\x7f]/);
  assert.match(text, /\\u2014 see \\u00a717 \\u2192 fixed\\u2026 \\ud83e\\udd16/);
  assert.ok(text.endsWith("}\n"));
  assert.deepEqual(JSON.parse(text), value);
});

test("tests/wpt-expectations.json is already in the writer's form", () => {
  const committed = readFileSync(EXPECT_FILE, "utf8");
  assert.equal(stringifyAsciiJSON(JSON.parse(committed)), committed);
});

test("tests/wpt-expectations.json has only well-formed reclassified markers", () => {
  assert.deepEqual(reclassifiedErrors(JSON.parse(readFileSync(EXPECT_FILE, "utf8"))), []);
});

test("reclassifiedErrors accepts a marker whose to matches expected", () => {
  assert.deepEqual(reclassifiedErrors(marked({ from: "PASS", to: "FAIL", commit: SHA })), []);
  assert.deepEqual(
    reclassifiedErrors(marked({ from: "FAIL", to: "TIMEOUT", commit: SHA }, "TIMEOUT")),
    [],
  );
  assert.deepEqual(reclassifiedErrors({ "/u.html": { expected: "PASS", reason: null } }), []);
});

test("reclassifiedErrors rejects a stale, short, circular or malformed marker", () => {
  const errors = (marker, expected) => reclassifiedErrors(marked(marker, expected));
  assert.deepEqual(errors({ from: "PASS", to: "FAIL", commit: SHA }, "TIMEOUT"), [
    "/t.html: reclassified to FAIL differs from expected TIMEOUT: drop or update the marker",
  ]);
  assert.deepEqual(errors({ from: "PASS", to: "FAIL", commit: SHA.slice(0, 9) }), [
    "/t.html: reclassified commit is not a full lowercase hex SHA",
  ]);
  assert.deepEqual(errors({ from: "FAIL", to: "FAIL", commit: SHA }), [
    "/t.html: reclassified from equals to",
  ]);
  assert.deepEqual(errors({ from: "PASS", to: "FAIL", commit: SHA.toUpperCase() }), [
    "/t.html: reclassified commit is not a full lowercase hex SHA",
  ]);
  assert.deepEqual(errors({ from: "OK", to: "FAIL", commit: SHA, by: "x" }), [
    '/t.html: reclassified has unknown key "by"',
    '/t.html: reclassified from "OK" is not an outcome',
  ]);
  assert.deepEqual(errors("PASS->FAIL"), ["/t.html: reclassified is not an object"]);
  assert.deepEqual(errors(null), ["/t.html: reclassified is not an object"]);
});

test("rebaseline keeps reclassified and the other per-test fields", () => {
  const reclassified = { from: "PASS", to: "FAIL", commit: SHA };
  const expectations = {
    "/t.html": { expected: "FAIL", reason: "why", timeout: 20000, reclassified },
  };
  const { next } = rebaseline(expectations, [{ test: "/t.html", actual: "TIMEOUT" }]);
  assert.deepEqual(next["/t.html"], {
    expected: "TIMEOUT",
    reason: "why",
    timeout: 20000,
    reclassified,
  });
  assert.equal(reclassifiedErrors(next).length, 1, "a rebaseline off `to` leaves the marker stale");
});
