// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { applyRetries, retryCandidates } from "./gate.mjs";

const timeout = { expected: "PASS", outcome: "TIMEOUT", unexpected: true };
const fail = { expected: "PASS", outcome: "FAIL", unexpected: true, subPass: 1, subTotal: 2 };

test("retry candidates are limited to unexpected infrastructure outcomes", () => {
  assert.deepEqual(
    retryCandidates({
      "/timeout.html": timeout,
      "/fail.html": fail,
      "/pass.html": { expected: "PASS", outcome: "PASS", unexpected: false },
    }),
    { tests: ["/timeout.html"] },
  );
  assert.deepEqual(retryCandidates({ "/a.html": timeout, "/b.html": timeout }, 1), {
    tests: [],
    mass: 2,
  });
});

test("a draw matching the expectation removes a timeout deviation", () => {
  const result = applyRetries(
    { "/timeout.html": timeout },
    {
      "/timeout.html": [
        { outcome: "TIMEOUT", subPass: 0, subTotal: 0 },
        { outcome: "PASS", subPass: 3, subTotal: 3 },
      ],
    },
  );
  assert.equal(result.byFile["/timeout.html"].outcome, "PASS");
  assert.equal(result.byFile["/timeout.html"].unexpected, false);
  assert.equal(result.byFile["/timeout.html"].retried, "TIMEOUT");
});

test("without a passing draw, the best outcome remains gated", () => {
  const result = applyRetries(
    { "/timeout.html": timeout, "/fail.html": timeout },
    {
      "/timeout.html": [
        { outcome: "ERROR", subPass: 0 },
        { outcome: "TIMEOUT", subPass: 0 },
      ],
      "/fail.html": [
        { outcome: "FAIL", subPass: 1, subTotal: 3 },
        { outcome: "FAIL", subPass: 2, subTotal: 3 },
      ],
    },
  );
  assert.equal(result.byFile["/timeout.html"].outcome, "TIMEOUT");
  assert.equal(result.byFile["/timeout.html"].unexpected, true);
  assert.equal(result.byFile["/fail.html"].outcome, "FAIL");
  assert.equal(result.byFile["/fail.html"].subPass, 2);
  assert.equal(result.byFile["/fail.html"].unexpected, true);
});
