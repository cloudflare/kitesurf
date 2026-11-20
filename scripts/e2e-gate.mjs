// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Judge the e2e file actions and emit a JUnit report for their test results.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMain } from "./wpt-shared.mjs";

const USAGE =
  "usage: node scripts/e2e-gate.mjs --report <report.json next to file.json>... [--junit <file>]";
const xml = (value) =>
  String(value).replace(
    /[<>&\"']/g,
    (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char],
  );
const relativeName = (name) => name.slice(name.lastIndexOf("/test/e2e/") + 1);
const firstLine = (messages) =>
  String(messages?.[0] ?? "")
    .split("\n")[0]
    .slice(0, 400);

/** @param {object} report @returns {{file: string, name: string, status: string, ms: number, message: string}[]} */
export function cases(report) {
  const output = [];
  for (const file of report.testResults) {
    const name = relativeName(file.name);
    for (const test of file.assertionResults) {
      output.push({
        file: name,
        name: test.fullName,
        status: test.status,
        ms: test.duration ?? 0,
        message: firstLine(test.failureMessages),
      });
    }
    if (
      file.status === "failed" &&
      !file.assertionResults.some((test) => test.status === "failed")
    ) {
      output.push({
        file: name,
        name: "(file)",
        status: "failed",
        ms: 0,
        message: String(file.message ?? "")
          .split("\n")[0]
          .slice(0, 400),
      });
    }
  }
  return output;
}

/** @param {{file: string, name: string, status: string, ms: number, message: string}[]} all @returns {string} */
export function junit(all) {
  const rows = all.map((test) => {
    const body =
      test.status === "failed"
        ? `<failure message="${xml(test.message)}"/>`
        : test.status === "passed"
          ? ""
          : "<skipped/>";
    return `  <testcase classname="e2e.${xml(test.file)}" name="${xml(test.name)}" time="${(test.ms / 1000).toFixed(3)}">${body}</testcase>`;
  });
  const failures = all.filter((test) => test.status === "failed").length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="e2e" tests="${all.length}" failures="${failures}">\n${rows.join("\n")}\n</testsuite>\n`;
}

function main(argv) {
  const options = { reports: [], junit: process.env.XML_OUTPUT_FILE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--report") options.reports.push(argv[++i]);
    else if (argv[i] === "--junit") options.junit = argv[++i];
    else {
      console.error(USAGE);
      process.exit(2);
    }
  }
  if (!options.reports.length) {
    console.error(USAGE);
    process.exit(2);
  }
  const all = [];
  const retried = [];
  for (const path of options.reports) {
    const summary = JSON.parse(readFileSync(resolve(dirname(path), "file.json"), "utf8"));
    all.push(...cases(JSON.parse(readFileSync(path, "utf8"))));
    if (summary.attempts > 1) retried.push(summary.file);
  }
  if (options.junit) writeFileSync(options.junit, junit(all));
  const failed = all.filter((test) => test.status === "failed");
  const count = (status) => all.filter((test) => test.status === status).length;
  console.log(
    `[e2e-gate] ${options.reports.length} file(s): ${count("passed")} passed, ${failed.length} failed, ${all.length - count("passed") - failed.length} skipped`,
  );
  for (const test of failed)
    console.log(`  FAIL ${test.file} > ${test.name}\n       ${test.message}`);
  // A file action fails unless its run or its retry passed, so these passed only on the retry.
  for (const file of retried) console.log(`  FLAKY ${file} (passed on its retry)`);
  process.exit(failed.length ? 1 : 0);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
