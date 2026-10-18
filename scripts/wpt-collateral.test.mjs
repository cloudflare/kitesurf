// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { planRowDisposition } from "./wpt-collateral.mjs";

const row = (test_, actual, extra = {}) => ({
  test: test_,
  actual,
  unexpected: actual !== "PASS",
  ...extra,
});
const names = (rows) => rows.map((r) => r.test);

test("no death: every row is accepted, nothing retried", () => {
  const results = [row("/a", "PASS"), row("/b", "FAIL"), row("/c", "TIMEOUT")];
  const { accept, requeue } = planRowDisposition({
    results,
    sawDeath: false,
    lastPass: false,
    retriedKillers: new Set(),
  });
  assert.deepEqual(names(accept), ["/a", "/b", "/c"]);
  assert.deepEqual(names(requeue), []);
});

test("death: bystanders are requeued, healthy rows kept", () => {
  const results = [
    row("/passed", "PASS"),
    row("/expected-fail", "FAIL", { unexpected: false }),
    row("/bystander", "TIMEOUT"),
    row("/killer", "TIMEOUT", { killedEngine: true }),
  ];
  const { accept, requeue } = planRowDisposition({
    results,
    sawDeath: true,
    lastPass: false,
    retriedKillers: new Set(),
  });
  assert.deepEqual(names(accept), ["/passed", "/expected-fail"]);
  assert.deepEqual(names(requeue), ["/bystander", "/killer"]);
});

test("a killer is retried once, then its row stands", () => {
  const retriedKillers = new Set();
  const first = planRowDisposition({
    results: [row("/killer", "TIMEOUT", { killedEngine: true })],
    sawDeath: true,
    lastPass: false,
    retriedKillers,
  });
  assert.deepEqual(names(first.requeue), ["/killer"]);
  assert.ok(retriedKillers.has("/killer"));

  const second = planRowDisposition({
    results: [row("/killer", "TIMEOUT", { killedEngine: true })],
    sawDeath: true,
    lastPass: false,
    retriedKillers,
  });
  assert.deepEqual(names(second.accept), ["/killer"]);
  assert.deepEqual(names(second.requeue), []);
});

test("a misblamed killer clears itself on the retry", () => {
  const retriedKillers = new Set();
  planRowDisposition({
    results: [row("/innocent", "TIMEOUT", { killedEngine: true })],
    sawDeath: true,
    lastPass: false,
    retriedKillers,
  });
  const retry = planRowDisposition({
    results: [row("/innocent", "PASS")],
    sawDeath: false,
    lastPass: false,
    retriedKillers,
  });
  assert.deepEqual(names(retry.accept), ["/innocent"]);
  assert.deepEqual(names(retry.requeue), []);
});

test("last pass accepts everything, even after a death", () => {
  const results = [row("/bystander", "TIMEOUT"), row("/killer", "CRASH", { killedEngine: true })];
  const { accept, requeue } = planRowDisposition({
    results,
    sawDeath: true,
    lastPass: true,
    retriedKillers: new Set(),
  });
  assert.deepEqual(names(accept), ["/bystander", "/killer"]);
  assert.deepEqual(names(requeue), []);
});

test("only CRASH/TIMEOUT/ERROR are treated as collateral", () => {
  const results = [row("/regressed", "FAIL"), row("/errored", "ERROR")];
  const { accept, requeue } = planRowDisposition({
    results,
    sawDeath: true,
    lastPass: false,
    retriedKillers: new Set(),
  });
  assert.deepEqual(names(accept), ["/regressed"]);
  assert.deepEqual(names(requeue), ["/errored"]);
});
