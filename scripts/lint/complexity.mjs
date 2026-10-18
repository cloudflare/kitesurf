// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, oxlintConfigPath, packageBin, sourceFiles } from "./scope.mjs";

const CODE_EXTENSIONS = ["cjs", "cts", "js", "jsx", "mjs", "mts", "ts", "tsx"];
const REVIEW_THRESHOLD = 20;
const TOP_LIMIT = 20;
const MAX_OXLINT_OUTPUT_BYTES = 32 * 1024 * 1024;
const OXLINT_TIMEOUT_MS = 120_000;
const MAX_FAILURE_OUTPUT_CHARACTERS = 16_000;
const MAX_ERROR_DIAGNOSTICS = 100;
const MAX_DIAGNOSTIC_MESSAGE_CHARACTERS = 600;

/**
 * @typedef {{file: string, line: number | null, column: number | null,
 *   ruleId: string, message: string}} NativeError
 * @typedef {{file: string, line: number, column: number, score: number}} ComplexityFinding
 * @typedef {{extends: string[], rules: {complexity: ["warn", {
 *   max: 0, variant: "modified"
 * }]}}} ComplexityConfig
 * @typedef {{diagnostics: unknown[]}} OxlintReport
 * @typedef {{filename: string, code: string, message: string,
 *   severity: "warning" | "error", labels: unknown[]}} OxlintDiagnostic
 * @typedef {{line: number | null, column: number | null}} DiagnosticLocation
 * @typedef {{ok: true, findings: ComplexityFinding[]} | {
 *   ok: false, exitCode: number, reason: string, nativeErrors: NativeError[]
 * }} ComplexityAnalysis
 */

/**
 * @param {string} rootConfigPath
 * @returns {ComplexityConfig}
 */
export function createComplexityConfig(rootConfigPath) {
  return {
    extends: [rootConfigPath],
    rules: { complexity: ["warn", { max: 0, variant: "modified" }] },
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is unknown[]} */
function isUnknownArray(value) {
  return Array.isArray(value);
}

/** @param {string} ruleId */
function isComplexityRule(ruleId) {
  return ruleId === "eslint(complexity)";
}

/** @param {string} filePath @param {string} root */
function displayPath(filePath, root) {
  return relative(root, resolve(root, filePath)).split(sep).join("/");
}

/** @param {unknown} value @returns {value is OxlintReport} */
function isOxlintReport(value) {
  return isRecord(value) && isUnknownArray(value.diagnostics);
}

/** @param {unknown} value @returns {value is OxlintDiagnostic} */
function isOxlintDiagnostic(value) {
  return (
    isRecord(value) &&
    typeof value.filename === "string" &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.severity === "warning" || value.severity === "error") &&
    isUnknownArray(value.labels)
  );
}

/** @param {unknown[]} labels @returns {DiagnosticLocation} */
function diagnosticLocation(labels) {
  const firstLabel = labels[0];
  const span = isRecord(firstLabel) && isRecord(firstLabel.span) ? firstLabel.span : undefined;
  return {
    line: typeof span?.line === "number" && Number.isSafeInteger(span.line) ? span.line : null,
    column:
      typeof span?.column === "number" && Number.isSafeInteger(span.column) ? span.column : null,
  };
}

/** @param {string} message @returns {number | null} */
function complexityScore(message) {
  const scoreMatch = /\bcomplexity of (\d+)\b/iu.exec(message);
  if (scoreMatch === null) return null;
  const score = Number(scoreMatch[1]);
  return Number.isSafeInteger(score) ? score : null;
}

/**
 * @param {string} stdout
 * @param {string} root
 * @returns {{findings: ComplexityFinding[], nativeErrors: NativeError[]}}
 */
function parseOxlintReport(stdout, root) {
  /** @type {unknown} */
  const output = JSON.parse(stdout);
  if (!isOxlintReport(output)) {
    throw new Error("Oxlint JSON output did not contain a diagnostics list.");
  }

  /** @type {ComplexityFinding[]} */
  const findings = [];
  /** @type {NativeError[]} */
  const nativeErrors = [];

  for (const diagnostic of output.diagnostics) {
    if (!isOxlintDiagnostic(diagnostic)) {
      throw new Error("Oxlint JSON output contained an invalid diagnostic.");
    }
    const file = displayPath(diagnostic.filename, root);
    const { line, column } = diagnosticLocation(diagnostic.labels);

    if (diagnostic.severity === "error") {
      nativeErrors.push({
        file,
        line,
        column,
        ruleId: diagnostic.code,
        message: diagnostic.message,
      });
    }
    if (!isComplexityRule(diagnostic.code)) continue;

    const score = complexityScore(diagnostic.message);
    if (score === null || line === null || column === null) {
      throw new Error("An Oxlint complexity diagnostic did not include a score and location.");
    }
    findings.push({ file, line, column, score });
  }

  return { findings, nativeErrors };
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {{status: number | null, signal: string | null, error?: Error,
 *   stdout?: string | null, stderr?: string | null}} result
 * @param {string} [root]
 * @returns {ComplexityAnalysis}
 */
export function analyzeOxlintResult(result, root = ROOT) {
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  let report;
  let parseFailure;
  try {
    report = parseOxlintReport(stdout, root);
  } catch (error) {
    parseFailure = errorMessage(error);
  }
  const nativeErrors = report?.nativeErrors ?? [];

  if (result.error !== undefined) {
    return {
      ok: false,
      exitCode: 1,
      reason: `Oxlint did not complete: ${result.error.message}`,
      nativeErrors,
    };
  }
  if (result.signal !== null) {
    return {
      ok: false,
      exitCode: 1,
      reason: `Oxlint terminated after signal ${result.signal}.`,
      nativeErrors,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      exitCode: result.status ?? 1,
      reason: `Oxlint exited with status ${result.status ?? "unknown"}.`,
      nativeErrors,
    };
  }
  if (parseFailure !== undefined) {
    return {
      ok: false,
      exitCode: 1,
      reason: `Could not read Oxlint's JSON report: ${parseFailure}`,
      nativeErrors,
    };
  }
  if (nativeErrors.length > 0) {
    return {
      ok: false,
      exitCode: 1,
      reason: `Oxlint reported ${nativeErrors.length} error(s) with a successful exit status.`,
      nativeErrors,
    };
  }

  return { ok: true, findings: report.findings };
}

/**
 * @param {ComplexityFinding[]} findings
 * @returns {string}
 */
export function formatComplexityReport(findings) {
  const ordered = [...findings].sort(
    (left, right) =>
      right.score - left.score ||
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column,
  );
  const atOrAboveThreshold = ordered.filter(({ score }) => score >= REVIEW_THRESHOLD).length;
  const top = ordered.slice(0, TOP_LIMIT);
  const lines = [
    `Cyclomatic complexity (modified): ${ordered.length} function scores; ` +
      `${atOrAboveThreshold} at or above ${REVIEW_THRESHOLD}.`,
  ];

  if (top.length === 0) {
    lines.push("No function scores were reported.");
  } else {
    lines.push(`Top ${top.length} by score:`);
    for (const finding of top) {
      lines.push(`  CC ${finding.score}  ${finding.file}:${finding.line}:${finding.column}`);
    }
  }

  return lines.join("\n");
}

/** @param {string} value @param {number} limit */
function truncate(value, limit) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…`;
}

/** @param {string | null | undefined} output */
function writeCappedFailureOutput(output) {
  if (typeof output !== "string" || output.length === 0) return;
  process.stderr.write(truncate(output, MAX_FAILURE_OUTPUT_CHARACTERS));
  if (output.length > MAX_FAILURE_OUTPUT_CHARACTERS) {
    process.stderr.write("\n[complexity] Additional native output was omitted.\n");
  } else if (!output.endsWith("\n")) {
    process.stderr.write("\n");
  }
}

/** @param {NativeError[]} errors */
function writeNativeErrors(errors) {
  for (const diagnostic of errors.slice(0, MAX_ERROR_DIAGNOSTICS)) {
    const location = `${diagnostic.file}:${diagnostic.line ?? "?"}:${diagnostic.column ?? "?"}`;
    const message = truncate(diagnostic.message, MAX_DIAGNOSTIC_MESSAGE_CHARACTERS);
    process.stderr.write(`${location} ${diagnostic.ruleId}: ${message}\n`);
  }
  if (errors.length > MAX_ERROR_DIAGNOSTICS) {
    process.stderr.write(
      `[complexity] ${errors.length - MAX_ERROR_DIAGNOSTICS} additional native error(s) omitted.\n`,
    );
  }
}

/** @param {ReturnType<typeof spawnSync>} result @param {ComplexityAnalysis} analysis */
function reportFailure(result, analysis) {
  process.stderr.write(`[complexity] ${analysis.reason} Complexity report suppressed.\n`);
  if (analysis.nativeErrors.length > 0) {
    writeNativeErrors(analysis.nativeErrors);
    writeCappedFailureOutput(result.stderr);
  } else {
    writeCappedFailureOutput(result.stderr);
    writeCappedFailureOutput(result.stdout);
  }
  process.exitCode = analysis.exitCode;
}

function runComplexityReport() {
  const files = sourceFiles(CODE_EXTENSIONS, ".oxlintrc.json");
  if (files.length === 0) {
    process.stdout.write("[complexity] No authored JavaScript/TypeScript files selected.\n");
    return;
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "kitesurf-complexity-"));
  try {
    const configPath = join(temporaryDirectory, "oxlint.config.json");
    writeFileSync(configPath, JSON.stringify(createComplexityConfig(oxlintConfigPath())));
    const [node, oxlint] = packageBin("oxlint");
    const result = spawnSync(
      node,
      [
        ...oxlint,
        "--config",
        configPath,
        "--disable-nested-config",
        "--threads",
        "2",
        "--format=json",
        ...files,
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: MAX_OXLINT_OUTPUT_BYTES,
        timeout: OXLINT_TIMEOUT_MS,
      },
    );
    const analysis = analyzeOxlintResult(result);
    if (!analysis.ok) {
      reportFailure(result, analysis);
      return;
    }
    process.stdout.write(`${formatComplexityReport(analysis.findings)}\n`);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runComplexityReport();
  } catch (error) {
    process.stderr.write(`[complexity] Could not produce the report: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
