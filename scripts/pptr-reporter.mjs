// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Mocha reporter for pptr-run: spec output on the console, and a JSON report with only the
// fields pptr-shared reads. Upstream's reporter serializes whole error objects, so one BigInt
// in an assertion makes JSON.stringify throw and the file loses every result.

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

// pptr-run starts mocha in the Puppeteer checkout, which provides mocha.
const Mocha = createRequire(join(process.cwd(), "package.json"))("mocha");
const { EVENT_RUN_END, EVENT_TEST_END, EVENT_TEST_FAIL, EVENT_TEST_PASS, EVENT_TEST_PENDING } =
  Mocha.Runner.constants;

function describeError(err) {
  try {
    return {
      code: typeof err?.code === "string" ? err.code : undefined,
      message: String(err?.message ?? err),
    };
  } catch {
    return { message: "(unprintable error)" };
  }
}

function entry(test, err) {
  return {
    title: test.title,
    fullTitle: test.fullTitle(),
    duration: test.duration ?? 0,
    ...(err === undefined ? {} : { err: describeError(err) }),
  };
}

export default class PptrReporter extends Mocha.reporters.Spec {
  constructor(runner, options) {
    super(runner, options);
    const output = options?.reporterOption?.output;
    if (!output) throw new Error("pptr-reporter needs -O output=<file>");
    const report = { tests: [], passes: [], failures: [], pending: [] };
    runner.on(EVENT_TEST_END, (test) => report.tests.push(entry(test)));
    runner.on(EVENT_TEST_PASS, (test) => report.passes.push(entry(test)));
    runner.on(EVENT_TEST_PENDING, (test) => report.pending.push(entry(test)));
    runner.on(EVENT_TEST_FAIL, (test, err) => report.failures.push(entry(test, err)));
    runner.once(EVENT_RUN_END, () => writeFileSync(output, JSON.stringify(report, null, 1)));
  }
}
