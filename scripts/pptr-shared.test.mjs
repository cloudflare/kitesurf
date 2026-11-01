// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  collectResults,
  coverageGaps,
  errorSummary,
  exactGrep,
  isHookId,
  loadAllowList,
  mergeRetry,
  rebaselineSlow,
  retryPlan,
  skipConfig,
  splitId,
} from "./pptr-shared.mjs";

const t = (fullTitle, extra = {}) => ({
  title: fullTitle.split(" ").pop(),
  fullTitle,
  duration: 5,
  ...extra,
});

test("results key on the spec name and the full describe path", () => {
  const report = {
    tests: [t("Page Page.close should work"), t("Page Page.goto should work")],
    passes: [t("Page Page.close should work")],
    failures: [t("Page Page.goto should work", { err: { message: "boom" } })],
  };
  const { results, errors } = collectResults(report, "page.test");
  assert.deepEqual(results, {
    "[page.test] Page Page.close should work": "PASS",
    "[page.test] Page Page.goto should work": "FAIL",
  });
  assert.deepEqual(errors, { "[page.test] Page Page.goto should work": "boom" });
});

test("same-titled tests in different suites stay apart; duplicates are reported", () => {
  const report = {
    tests: [t("A inner x"), t("B inner x"), t("A dup"), t("A dup")],
    passes: [t("A inner x"), t("A dup")],
    failures: [t("B inner x"), t("A dup")],
  };
  const { results, duplicates } = collectResults(report, "f.test");
  assert.equal(results["[f.test] A inner x"], "PASS");
  assert.equal(results["[f.test] B inner x"], "FAIL");
  assert.equal(results["[f.test] A dup"], "FAIL");
  assert.deepEqual(duplicates, ["[f.test] A dup"]);
});

test("pending maps to SKIP and mocha timeouts to TIMEOUT", () => {
  const report = {
    tests: [t("S slow"), t("S skipped")],
    pending: [t("S skipped")],
    failures: [t("S slow", { duration: 15_000, err: { code: "ERR_MOCHA_TIMEOUT" } })],
  };
  const { results, durations } = collectResults(report, "f.test");
  assert.deepEqual(results, { "[f.test] S slow": "TIMEOUT", "[f.test] S skipped": "SKIP" });
  assert.equal(durations["[f.test] S slow"], 15_000);
});

test("a failed hook gets its own ID", () => {
  const hook = { title: '"after each" hook for "x"', fullTitle: 'S "after each" hook for "x"' };
  const report = { tests: [t("S x")], passes: [t("S x")], failures: [hook] };
  const { results, duplicates } = collectResults(report, "f.test");
  assert.equal(results['[f.test] S "after each" hook for "x"'], "FAIL");
  assert.equal(results["[f.test] S x"], "PASS");
  assert.deepEqual(duplicates, []);
  assert.equal(isHookId('[f.test] S "after each" hook for "x"'), true);
  assert.equal(isHookId("[f.test] S x"), false);
});

test("IDs split back into spec name and full title", () => {
  assert.deepEqual(splitId("[page.test] Page [weird] title"), {
    file: "page.test",
    fullTitle: "Page [weird] title",
  });
  assert.throws(() => splitId("page.test::x"));
});

test("skip config lists only SKIP pins, optionally for some files", () => {
  const expectations = {
    "[a.test] S x": { expected: "SKIP" },
    "[a.test] S y": { expected: "FAIL" },
    "[b.test] S z": { expected: "SKIP" },
  };
  assert.deepEqual(JSON.parse(skipConfig(expectations)), [
    { testIdPattern: "[a.test] S x", skip: true },
    { testIdPattern: "[b.test] S z", skip: true },
  ]);
  assert.deepEqual(JSON.parse(skipConfig(expectations, ["b.test"])), [
    { testIdPattern: "[b.test] S z", skip: true },
  ]);
  assert.deepEqual(
    JSON.parse(skipConfig(expectations, ["b.test"], ["[b.test] S z", "[b.test] S w"])),
    [
      { testIdPattern: "[b.test] S z", skip: true },
      { testIdPattern: "[b.test] S w", skip: true },
    ],
  );
});

test("exact grep matches whole titles only, with regex characters escaped", () => {
  const grep = new RegExp(exactGrep(["S a(1)", "S b.c"]));
  assert.equal(grep.test("S a(1)"), true);
  assert.equal(grep.test("S b.c"), true);
  assert.equal(grep.test("S bxc"), false);
  assert.equal(grep.test("S a(1) more"), false);
});

test("allow-list takes spec names and rejects paths or extensions", () => {
  const dir = mkdtempSync(join(os.tmpdir(), "pptr-shared-"));
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify(["page.test", { file: "frame.test", only: ["F x"] }]));
  assert.deepEqual(loadAllowList(good), [
    { file: "page.test", only: null },
    { file: "frame.test", only: ["F x"] },
  ]);
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify(["test/build/page.test.js"]));
  assert.throws(() => loadAllowList(bad), /not a spec name/);
});

test("coverage finds empty spec files and vanished pins", () => {
  const specs = [
    { file: "a.test", only: null },
    { file: "b.test", only: ["S kept"] },
    { file: "c.test", only: null },
  ];
  const results = { "[a.test] S x": "PASS", "[b.test] S kept": "FAIL" };
  const expectations = {
    "[a.test] S gone": { expected: "FAIL" },
    "[a.test] S skipped": { expected: "SKIP" },
    "[b.test] S other": { expected: "FAIL" },
    "[b.test] S kept": { expected: "FAIL" },
    "[z.test] S elsewhere": { expected: "FAIL" },
  };
  assert.deepEqual(coverageGaps(results, specs, expectations), {
    emptyFiles: ["c.test"],
    missingPins: ["[a.test] S gone"],
  });
});

test("error summaries keep the first lines without colour codes", () => {
  const message =
    "\u001b[2mexpect(received).toBe(expected)\u001b[22m\n\nExpected: 1\nReceived: 2\nmore";
  assert.equal(
    errorSummary(message),
    "expect(received).toBe(expected) / Expected: 1 / Received: 2",
  );
  assert.equal(errorSummary("x".repeat(300)).length, 200);
  assert.equal(errorSummary(undefined), "");
});

test("rebaseline pins timeouts and slow failures as SKIP", () => {
  const next = rebaselineSlow(
    { "[a.test] S fixed": { expected: "FAIL" } },
    [
      { id: "[a.test] S fixed", actual: "PASS" },
      { id: "[a.test] S quick", actual: "FAIL" },
      { id: "[a.test] S slow", actual: "FAIL" },
      { id: "[a.test] S hang", actual: "TIMEOUT" },
    ],
    { "[a.test] S quick": 200, "[a.test] S slow": 12_000, "[a.test] S hang": 15_000 },
    { "[a.test] S quick": "boom", "[a.test] S slow": "late" },
  );
  assert.deepEqual(Object.keys(next), ["[a.test] S hang", "[a.test] S quick", "[a.test] S slow"]);
  assert.deepEqual(next["[a.test] S quick"], { expected: "FAIL", reason: "auto: boom" });
  assert.equal(next["[a.test] S slow"].reason, "auto: FAIL after 12.0s: late");
  assert.equal(next["[a.test] S slow"].expected, "SKIP");
  assert.equal(next["[a.test] S hang"].expected, "SKIP");
});

test("a retry skips the tests that matched and keeps their first results", () => {
  const first = {
    results: { "[a.test] S ok": "PASS", "[a.test] S bad": "FAIL", "[a.test] S pinned": "SKIP" },
    durations: { "[a.test] S ok": 1, "[a.test] S bad": 2, "[a.test] S pinned": 0 },
    errors: { "[a.test] S bad": "boom" },
    duplicates: [],
  };
  const plan = retryPlan(first.results, [{ id: "[a.test] S bad" }]);
  assert.deepEqual(plan, { whole: false, skipIds: ["[a.test] S ok", "[a.test] S pinned"] });
  const retry = {
    results: { "[a.test] S ok": "SKIP", "[a.test] S bad": "PASS", "[a.test] S pinned": "SKIP" },
    durations: { "[a.test] S bad": 3 },
    errors: {},
    duplicates: [],
  };
  const merged = mergeRetry(first, retry, plan);
  assert.deepEqual(merged.results, {
    "[a.test] S ok": "PASS",
    "[a.test] S bad": "PASS",
    "[a.test] S pinned": "SKIP",
  });
  assert.deepEqual(merged.errors, {});
});

test("a hook failure or an empty run retries the whole file", () => {
  const hook = '[a.test] S "after each" hook for "x"';
  assert.deepEqual(retryPlan({ "[a.test] S x": "PASS", [hook]: "FAIL" }, [{ id: hook }]), {
    whole: true,
    skipIds: [],
  });
  assert.deepEqual(retryPlan({}, []), { whole: true, skipIds: [] });
  const retry = { results: { "[a.test] S x": "PASS" }, durations: {}, errors: {}, duplicates: [] };
  assert.equal(
    mergeRetry({ results: { [hook]: "FAIL" }, durations: {}, errors: {}, duplicates: [] }, retry, {
      whole: true,
      skipIds: [],
    }),
    retry,
  );
});
