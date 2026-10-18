// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  analyzeOxlintResult,
  createComplexityConfig,
  formatComplexityReport,
} from "./complexity.mjs";

const root = "/repo";
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const MAX_OXLINT_OUTPUT_BYTES = 32 * 1024 * 1024;
const OXLINT_TIMEOUT_MS = 120_000;

function diagnostic(code, severity, message, line, filename = `${root}/src/example.ts`) {
  return {
    code,
    severity,
    message,
    filename,
    labels: [{ span: { offset: 0, length: 1, line, column: 1 } }],
  };
}

function oxlintResult(diagnostics, status = 0) {
  return {
    status,
    signal: null,
    stdout: JSON.stringify({
      diagnostics,
      number_of_files: 1,
      number_of_rules: 16,
      threads_count: 2,
      start_time: 0.2,
    }),
    stderr: "",
  };
}

test("temporary config extends the root config and overrides only complexity", () => {
  assert.deepEqual(createComplexityConfig(`${root}/.oxlintrc.json`), {
    extends: [`${root}/.oxlintrc.json`],
    rules: { complexity: ["warn", { max: 0, variant: "modified" }] },
  });
});

test("installed Oxlint JSON diagnostics are accepted by the analyzer", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "kitesurf-complexity-cli-"));
  try {
    const fixturePath = join(temporaryDirectory, "complexity-fixture.js");
    const branches = Array.from(
      { length: 21 },
      (_, index) => `  if (value === ${index}) return ${index};`,
    ).join("\n");
    writeFileSync(
      fixturePath,
      `/** @param {number} value @returns {number} */\n` +
        `export function highComplexity(value) {\n${branches}\n  return -1;\n}\n`,
    );

    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "oxlint",
        "--config",
        join(repositoryRoot, ".oxlintrc.json"),
        "--disable-nested-config",
        "--threads",
        "2",
        "--format=json",
        "--warn=complexity",
        fixturePath,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        maxBuffer: MAX_OXLINT_OUTPUT_BYTES,
        timeout: OXLINT_TIMEOUT_MS,
      },
    );
    const analysis = analyzeOxlintResult(result, repositoryRoot);
    if (!analysis.ok) throw new Error(analysis.reason);

    assert.equal(analysis.findings.length, 1);
    assert.ok(analysis.findings[0].file.endsWith("complexity-fixture.js"));
    assert.ok(analysis.findings[0].line > 0);
    assert.ok(analysis.findings[0].column > 0);
    assert.ok(analysis.findings[0].score >= 20);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("complexity warnings are advisory and the report counts and sorts every score", () => {
  const messages = Array.from({ length: 21 }, (_, index) => {
    const score = index + 1;
    return diagnostic(
      "eslint(complexity)",
      "warning",
      `Function has a complexity of ${score}. Maximum allowed is 0.`,
      score,
    );
  });
  messages.push(diagnostic("no-debugger", "warning", "Unexpected debugger statement.", 30));

  const analysis = analyzeOxlintResult(oxlintResult(messages), root);
  if (!analysis.ok) throw new Error(analysis.reason);

  assert.equal(analysis.findings.length, 21);
  const report = formatComplexityReport(analysis.findings);
  assert.match(report, /21 function scores; 2 at or above 20\./u);
  assert.match(report, /Top 20 by score:/u);
  const scoreLines = report.split("\n").filter((line) => line.startsWith("  CC "));
  assert.equal(scoreLines.length, 20);
  assert.match(scoreLines[0], /CC 21 /u);
  assert.match(scoreLines.at(-1), /CC 2 /u);
});

test("native Oxlint errors remain failures instead of producing an advisory success", () => {
  const analysis = analyzeOxlintResult(
    oxlintResult(
      [
        diagnostic(
          "eslint(complexity)",
          "warning",
          "Function has a complexity of 24. Maximum allowed is 0.",
          1,
        ),
        diagnostic("no-debugger", "error", "Unexpected debugger statement.", 2),
      ],
      1,
    ),
    root,
  );

  assert.equal(analysis.ok, false);
  if (analysis.ok) throw new Error("expected native Oxlint errors to fail the report");
  assert.equal(analysis.exitCode, 1);
  assert.equal(analysis.nativeErrors.length, 1);
});

test("invalid Oxlint JSON remains a reporter failure", () => {
  const analysis = analyzeOxlintResult(
    { status: 0, signal: null, stdout: "not JSON", stderr: "" },
    root,
  );

  assert.equal(analysis.ok, false);
  if (analysis.ok) throw new Error("expected invalid Oxlint JSON to fail the report");
  assert.match(analysis.reason, /Could not read Oxlint's JSON report/u);
});

test("Oxlint process failures remain reporter failures", () => {
  const analysis = analyzeOxlintResult(
    { status: null, signal: null, error: new Error("spawn failed"), stdout: "", stderr: "" },
    root,
  );

  assert.equal(analysis.ok, false);
  if (analysis.ok) throw new Error("expected an Oxlint spawn failure to fail the report");
  assert.match(analysis.reason, /Oxlint did not complete/u);
});

test("an unscored complexity diagnostic fails rather than disappearing from the report", () => {
  const analysis = analyzeOxlintResult(
    oxlintResult([diagnostic("eslint(complexity)", "warning", "Unexpected complexity output.", 1)]),
    root,
  );

  assert.equal(analysis.ok, false);
  if (analysis.ok) throw new Error("expected an invalid complexity report to fail");
  assert.match(analysis.reason, /did not include a score and location/u);
});
