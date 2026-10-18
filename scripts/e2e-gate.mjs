// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Judge the public e2e shards and emit a JUnit report for their test results.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMain } from "./wpt-shared.mjs";

const USAGE =
  "usage: node scripts/e2e-gate.mjs --shard <dir with report.json and shard.json>... [--junit <file>]";
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
  const options = { shards: [], junit: process.env.XML_OUTPUT_FILE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--shard") options.shards.push(argv[++i]);
    else if (argv[i] === "--junit") options.junit = argv[++i];
    else {
      console.error(USAGE);
      process.exit(2);
    }
  }
  if (!options.shards.length) {
    console.error(USAGE);
    process.exit(2);
  }
  const all = [];
  const failedShards = [];
  let files = 0;
  for (const argument of options.shards) {
    const dir = argument.endsWith(".json") ? dirname(argument) : argument;
    const shard = JSON.parse(readFileSync(resolve(dir, "shard.json"), "utf8"));
    const report = JSON.parse(readFileSync(resolve(dir, "report.json"), "utf8"));
    files += report.testResults.length;
    all.push(...cases(report));
    if (shard.exit !== 0)
      failedShards.push(`${dir} (vitest exit ${shard.exit}, ${shard.seconds}s)`);
  }
  if (options.junit) writeFileSync(options.junit, junit(all));
  const failed = all.filter((test) => test.status === "failed");
  const count = (status) => all.filter((test) => test.status === status).length;
  console.log(
    `[e2e-gate] ${options.shards.length} shard(s), ${files} file(s): ${count("passed")} passed, ${failed.length} failed, ${all.length - count("passed") - failed.length} skipped`,
  );
  for (const test of failed)
    console.log(`  FAIL ${test.file} > ${test.name}\n       ${test.message}`);
  for (const shard of failedShards) console.log(`  vitest failed in ${shard}`);
  process.exit(failed.length || failedShards.length ? 1 : 0);
}

if (isMain(import.meta.url)) main(process.argv.slice(2));
