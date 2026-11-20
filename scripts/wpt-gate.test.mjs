// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { annotations, applyRetries, markdownSummary, retryCandidates } from "./wpt-gate.mjs";

const timeout = { expected: "PASS", outcome: "TIMEOUT", unexpected: true };
const fail = { expected: "PASS", outcome: "FAIL", unexpected: true, subPass: 1, subTotal: 2 };

test("retry candidates are unexpected infrastructure outcomes and lost passes", () => {
  assert.deepEqual(
    retryCandidates({
      "/timeout.html": timeout,
      "/fail.html": fail,
      "/fail-to-pass.html": { expected: "FAIL", outcome: "PASS", unexpected: true },
      "/timeout-to-fail.html": { expected: "TIMEOUT", outcome: "FAIL", unexpected: true },
      "/pass.html": { expected: "PASS", outcome: "PASS", unexpected: false },
    }),
    { tests: ["/fail.html", "/timeout.html"] },
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

test("a passing draw removes a fail deviation", () => {
  const result = applyRetries(
    { "/fail.html": fail },
    { "/fail.html": [{ outcome: "PASS", subPass: 2, subTotal: 2 }] },
  );
  assert.equal(result.byFile["/fail.html"].unexpected, false);
  assert.equal(result.byFile["/fail.html"].retried, "FAIL");
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

const flake = {
  expected: "PASS",
  outcome: "PASS",
  unexpected: false,
  retried: "TIMEOUT",
  retryDraws: ["PASS", "TIMEOUT"],
};

test("the summary lists unexpected results and retries", () => {
  const md = markdownSummary(
    { "/a|b.html": fail, "/flake.html": flake, "/ok.html": { ...flake, retried: undefined } },
    ["/flake.html: retry passed; treat first result as a flake", "16 retry candidates exceed it"],
  );
  assert.match(md, /^## WPT expectations gate: failed$/m);
  assert.match(md, /^3 tests: 2 as expected, 1 unexpected fail, 0 unexpected pass\.$/m);
  assert.match(md, /^\| `\/a\\\|b\.html` \| PASS \| FAIL \| 1\/2 \|$/m);
  assert.match(md, /^\| `\/flake\.html` \| TIMEOUT \| PASS, TIMEOUT \| flake \|$/m);
  assert.match(md, /^- 16 retry candidates exceed it$/m);
  assert.doesNotMatch(md, /retry passed;/);
  assert.match(markdownSummary({ "/ok.html": flake }, []), /gate: passed/);
  assert.ok(markdownSummary({ "/a\\|b.html": fail }, []).includes("| `/a\\\\\\|b.html` |"));
});

test("annotations escape workflow commands and stay under GitHub's cap", () => {
  assert.equal(
    annotations({ "/a.html?x=1,2": fail, "/flake.html": flake }),
    "::error title=WPT PASS → FAIL::/a.html?x=1,2 (1/2 subtests)\n" +
      "::warning title=WPT flake%3A TIMEOUT::/flake.html (retry draws: PASS, TIMEOUT)\n",
  );
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`/t${i}.html`, fail]));
  const errors = annotations(many).trim().split("\n");
  assert.equal(errors.length, 10);
  assert.equal(errors[9], "::error title=WPT::3 more unexpected results");
  assert.equal(annotations({}), "");
});
