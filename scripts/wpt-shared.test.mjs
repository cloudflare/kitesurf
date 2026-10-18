// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { EXPECT_FILE, referenceUrlForVariant, stringifyAsciiJSON } from "./wpt-shared.mjs";

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
