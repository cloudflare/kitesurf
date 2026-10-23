// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");
export const TESTS_FILE = resolve(ROOT, "tests/wpt-tests.json");
export const EXPECT_FILE = resolve(ROOT, "tests/wpt-expectations.json");
export const WPT_ROOT = resolve(ROOT, ".wpt");
export const REVISION_FILE = resolve(ROOT, "tests/wpt-revision.json");
export const REPORT_DIR = resolve(ROOT, ".wpt-reports");

export const DEFAULT_WPT_BASE = "http://web-platform.test:8000";

const JSON_UNICODE_ESCAPE_HEX_DIGITS = 4;
const KNOWN_OUTCOMES = new Set(["PASS", "FAIL", "ERROR", "TIMEOUT", "CRASH", "SKIP"]);
const SKIP_WPT_DIRECTORIES = new Set(["resources", "support", "crashtests"]);
const EXCLUDED_WPT_FILE_PATTERNS = [
  /-ref(-[^/]*)?\.x?html?$/,
  /-notref\.x?html?$/,
  /-mismatch\.x?html?$/,
  /\.(headers|ini|lock|md|yaml|yml|py)$/,
];

const useColor = process.stdout.isTTY;
const c = (code, s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : s);
/** @returns {string} */
export const green = (s) => c(32, s);
/** @returns {string} */
export const red = (s) => c(31, s);
/** @returns {string} */
export const yellow = (s) => c(33, s);
/** @returns {string} */
export const dim = (s) => c(2, s);
/** @returns {string} */
export const bold = (s) => c(1, s);

/** @returns {unknown} */
export function loadJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

/** @returns {string} */
export function stringifyAsciiJSON(value) {
  // Escape non-ASCII units so one-test rebaselines leave unrelated reason strings unchanged.
  return (
    JSON.stringify(value, null, 2).replace(
      /[\u0080-\uffff]/g,
      (ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(JSON_UNICODE_ESCAPE_HEX_DIGITS, "0"),
    ) + "\n"
  );
}

/** @returns {string} */
export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/** @returns {string} */
export function gitShortSha() {
  try {
    const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 1000,
    });
    if (r.status === 0) return r.stdout.trim();
  } catch {}
  return "unknown";
}

/** @returns {string | null} */
export function wptRevision() {
  try {
    const raw = JSON.parse(readFileSync(REVISION_FILE, "utf8"));
    return typeof raw.revision === "string" ? raw.revision : null;
  } catch {
    return null;
  }
}

/** @param {Record<string, object>} expectations @param {{test: string, actual: string, reason?: string}[]} results @returns {{next: Record<string, object>, skipped: number}} */
export function rebaseline(expectations, results) {
  const next = { ...expectations };
  let skipped = 0;
  for (const result of results) {
    skipped += Number(rebaselineResult(next, expectations, result));
  }
  return { next, skipped };
}

function shouldSkipRebaseline(result) {
  return result.actual === "SKIP" && /--skip-slow/.test(result.reason ?? "");
}

function rebaselineResult(next, expectations, result) {
  if (shouldSkipRebaseline(result)) return true;
  const previous = expectations[result.test] ?? {};
  next[result.test] = { ...previous, expected: result.actual, reason: previous.reason ?? null };
  return false;
}

/** @param {string} url @returns {boolean} */
export function isMain(url) {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

/** @returns {string} */
export function firstLine(s) {
  return String(s).split("\n", 1)[0].slice(0, 200);
}

/** @returns {string} */
export function formatCounts(counts) {
  const keys = Object.keys(counts);
  const ordered = [];
  for (const preferred of ["PASS", "FAIL", "TIMEOUT", "NOTRUN", "PRECONDITION_FAILED"]) {
    if (keys.includes(preferred)) ordered.push(preferred);
  }
  for (const k of keys.sort()) {
    if (!ordered.includes(k)) ordered.push(k);
  }
  return ordered.map((k) => `${counts[k]} ${k}`).join(", ");
}

function isRealSubtest(subtest) {
  return !(subtest.name && subtest.name.includes("synthesized from summary"));
}

function addSubtestOutcome(totals, status) {
  switch (status) {
    case "PASS":
      totals.pass += 1;
      break;
    case "FAIL":
      totals.fail += 1;
      break;
    default:
      totals.other += 1;
      break;
  }
}

function addSubtestCounts(totals, subtests) {
  for (const subtest of subtests.filter(isRealSubtest)) {
    addSubtestOutcome(totals, subtest.status);
  }
}

function addCountTotals(totals, counts) {
  for (const [status, count] of Object.entries(counts)) {
    switch (status) {
      case "PASS":
        totals.pass += count;
        break;
      case "FAIL":
        totals.fail += count;
        break;
      default:
        totals.other += count;
        break;
    }
  }
}

function tallyResult(totals, result) {
  if (result.subtests && result.subtests.length > 0) {
    addSubtestCounts(totals, result.subtests);
    return;
  }
  if (result.counts) addCountTotals(totals, result.counts);
}

/** @returns {{pass: number, fail: number, other: number, total: number}} */
export function tallySubtests(results) {
  const totals = { pass: 0, fail: 0, other: 0 };
  for (const result of results) tallyResult(totals, result);
  return { ...totals, total: totals.pass + totals.fail + totals.other };
}

/** @returns {{
 * total: number, expected: number, unexpectedFail: number,
 * unexpectedPass: number, byOutcome: Record<string, number>
 * }} */
export function summarize(results) {
  const byOutcome = {};
  let unexpectedFail = 0;
  let unexpectedPass = 0;
  for (const r of results) {
    const outcome = normalizedOutcome(r.actual);
    byOutcome[outcome] = (byOutcome[outcome] || 0) + 1;
    const unexpected = unexpectedCounts(r);
    unexpectedPass += unexpected.pass;
    unexpectedFail += unexpected.fail;
  }
  const total = results.length;
  return {
    total,
    expected: total - unexpectedFail - unexpectedPass,
    unexpectedFail,
    unexpectedPass,
    byOutcome,
  };
}

function normalizedOutcome(actual) {
  return KNOWN_OUTCOMES.has(actual) ? actual : "FAIL";
}

function unexpectedCounts(result) {
  if (!result.unexpected) return { pass: 0, fail: 0 };
  if (result.expected !== "PASS" && result.actual === "PASS") return { pass: 1, fail: 0 };
  return { pass: 0, fail: 1 };
}

function statusTag(result) {
  if (result.unexpected) return "❌";
  if (result.actual === "PASS") return "✓";
  return "·";
}

function resultNotes(result) {
  if (result.reason) return result.reason;
  return harnessErrorNote(result) || countsNote(result);
}

function harnessErrorNote(result) {
  if (result.harness?.status !== "ERROR" || !result.harness?.message) return "";
  return `harness ERROR: ${firstLine(result.harness.message)}`;
}

function countsNote(result) {
  return result.counts ? formatCounts(result.counts) : "";
}

function appendReportSummary(lines, summary) {
  lines.push("## Summary", "");
  lines.push(`- Total tests run: **${summary.total}**`);
  lines.push(`- Matching expectations: **${summary.expected}**`);
  lines.push(`- Unexpected passes: **${summary.unexpectedPass}**`);
  lines.push(`- Unexpected failures/regressions: **${summary.unexpectedFail}**`);
  lines.push("", "By outcome:");
  for (const [outcome, count] of Object.entries(summary.byOutcome).sort()) {
    lines.push(`- \`${outcome}\`: ${count}`);
  }
  lines.push("");
}

function appendTestTable(lines, results) {
  lines.push(
    "## Tests",
    "",
    "| Status | Test | Expected | Actual | Notes |",
    "|---|---|---|---|---|",
  );
  for (const result of results) {
    const notes = resultNotes(result).replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(
      `| ${statusTag(result)} | \`${result.test}\` | ${result.expected} | ${result.actual} | ${notes} |`,
    );
  }
}

function appendHarnessMessage(lines, message) {
  if (!message) return;
  lines.push("- **Harness message**:", "  ```");
  for (const line of String(message).split("\n").slice(0, 8)) {
    lines.push(`  ${line}`);
  }
  lines.push("  ```");
}

function appendHarnessDetails(lines, harness) {
  if (harness?.status) lines.push(`- **Harness**: ${harness.status}`);
  appendHarnessMessage(lines, harness?.message);
}

function realSubtests(result) {
  return (result.subtests || []).filter(
    (subtest) => !subtest.name?.includes("synthesized from summary"),
  );
}

function appendUnavailableSubtestDetails(lines, result) {
  if (result.counts) {
    lines.push(
      `- **Subtest counts**: ${formatCounts(result.counts)} (subtest names unavailable — testharness #results table didn't render)`,
    );
  }
  lines.push("");
}

function appendFailingSubtest(lines, subtest) {
  const message = (subtest.message || "").replace(/\n/g, " ").slice(0, 200);
  lines.push(`  - **${subtest.status}** — ${subtest.name}${message ? ` — ${message}` : ""}`);
}

function appendRemainingSubtests(lines, failing) {
  if (failing.length > 50) lines.push(`  - … and ${failing.length - 50} more`);
}

function appendFailingSubtests(lines, subtests) {
  const failing = subtests.filter((subtest) => subtest.status !== "PASS");
  if (failing.length > 0) {
    lines.push(`- **Failing subtests** (${failing.length}/${subtests.length}):`);
    for (const subtest of failing.slice(0, 50)) appendFailingSubtest(lines, subtest);
    appendRemainingSubtests(lines, failing);
  }
  lines.push("");
}

function appendSubtestDetails(lines, result, subtests) {
  if (subtests.length === 0) {
    appendUnavailableSubtestDetails(lines, result);
    return;
  }
  appendFailingSubtests(lines, subtests);
}

function appendTestDetails(lines, result) {
  const outcome = `- **Outcome**: ${result.actual}${result.unexpected ? " (unexpected)" : ""}`;
  lines.push(`### \`${result.test}\``, "", outcome);
  appendHarnessDetails(lines, result.harness);
  appendSubtestDetails(lines, result, realSubtests(result));
}

function appendNonPassDetails(lines, results) {
  const nonPass = results.filter((result) => result.actual !== "PASS" && result.actual !== "SKIP");
  if (nonPass.length === 0) return;
  lines.push("", "## Test details (non-PASS)", "");
  for (const result of nonPass) appendTestDetails(lines, result);
}

/** @returns {string} */
export function renderReportMd({ date, base, ws, summary, results }) {
  const lines = [`# Kitesurf WPT report — ${date}`, "", `Base: \`${base}\`  ·  CDP: \`${ws}\``, ""];
  appendReportSummary(lines, summary);
  appendTestTable(lines, results);
  appendNonPassDetails(lines, results);
  return lines.join("\n") + "\n";
}

/** @typedef {{
 * mdPath: string, jsonPath: string,
 * latestMdPath: string | null, latestJsonPath: string | null, historyPath: string | null
 * }} ReportPaths */

function reportData(date, base, ws, summary, results, ctx) {
  return {
    date,
    base,
    ws,
    commit: ctx?.commit ?? null,
    slice: ctx?.slice ?? null,
    summary,
    results,
  };
}

function writeCurrentReports(date, md, json) {
  const mdPath = resolve(REPORT_DIR, `${date}.md`);
  writeFileSync(mdPath, md);
  const jsonPath = resolve(REPORT_DIR, `${date}.json`);
  writeFileSync(jsonPath, JSON.stringify(json, null, 2));
  return { mdPath, jsonPath };
}

function reportHistoryRow(summary, results, ctx) {
  return {
    date: new Date().toISOString(),
    commit: ctx?.commit ?? null,
    slice: ctx?.slice ?? null,
    files: { ...summary.byOutcome },
    subtests: tallySubtests(results),
  };
}

function writeRecordedReports(md, json, summary, results, ctx) {
  if (!ctx?.record) {
    return { latestMdPath: null, latestJsonPath: null, historyPath: null };
  }
  const latestMdPath = resolve(REPORT_DIR, "latest.md");
  const latestJsonPath = resolve(REPORT_DIR, "latest.json");
  writeFileSync(latestMdPath, md);
  writeFileSync(latestJsonPath, JSON.stringify(json, null, 2));
  const historyPath = resolve(REPORT_DIR, "history.jsonl");
  appendFileSync(historyPath, JSON.stringify(reportHistoryRow(summary, results, ctx)) + "\n");
  return { latestMdPath, latestJsonPath, historyPath };
}

/** @returns {ReportPaths} */
export function writeReport(results, summary, ctx) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const date = todayISO();
  const base = ctx?.base ?? DEFAULT_WPT_BASE;
  const ws = ctx?.ws ?? "";
  const md = renderReportMd({ date, base, ws, summary, results });
  const json = reportData(date, base, ws, summary, results, ctx);
  const current = writeCurrentReports(date, md, json);
  const recorded = writeRecordedReports(md, json, summary, results, ctx);
  return { ...current, ...recorded };
}

const WPT_DOCUMENT_DETECTION_PREFIX_BYTES = 16_384;

function isRunnableWptDocument(fullPath, name) {
  if (/-crash(?:\.[\w-]+)*\.x?html?$/.test(name)) return true;
  let head;
  try {
    const fd = openSync(fullPath, "r");
    const buf = Buffer.alloc(WPT_DOCUMENT_DETECTION_PREFIX_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    head = buf.toString("utf8", 0, n);
  } catch {
    // Keep unreadable candidates enrolled so discovery does not silently hide them.
    return true;
  }
  if (/testharness(?:report)?\.js/.test(head)) return true;
  return /rel\s*=\s*["']?(match|mismatch)["']?/i.test(head);
}

function excludedWptFile(name) {
  return (
    name === "META.yml" ||
    name === ".gitignore" ||
    EXCLUDED_WPT_FILE_PATTERNS.some((pattern) => pattern.test(name))
  );
}

function htmlWptCandidate(fullPath, name) {
  if (!/\.(html|xhtml|htm)$/.test(name)) return null;
  if (!isRunnableWptDocument(fullPath, name)) return null;
  return { urlName: name, variantSource: "html" };
}

function wptFileCandidate(fullPath, name) {
  if (excludedWptFile(name)) return null;
  const html = htmlWptCandidate(fullPath, name);
  if (html) return html;
  if (/\.any\.js$/.test(name)) {
    return { urlName: name.replace(/\.any\.js$/, ".any.html"), variantSource: "js" };
  }
  if (/\.window\.js$/.test(name)) {
    return { urlName: name.replace(/\.window\.js$/, ".window.html"), variantSource: "js" };
  }
  return null;
}

function addDiscoveredFile(out, fullPath, name, directoryPart) {
  const candidate = wptFileCandidate(fullPath, name);
  if (!candidate) return;
  const variants = wptFileVariants(fullPath, candidate.variantSource);
  if (variants.length) {
    for (const variant of variants) out.push(directoryPart + candidate.urlName + variant);
  } else {
    out.push(directoryPart + candidate.urlName);
  }
}

function shouldSkipWptDirectory(name) {
  return SKIP_WPT_DIRECTORIES.has(name) || name.startsWith(".");
}

function walkWptEntry(dir, entry, out) {
  if (entry.isDirectory()) {
    if (shouldSkipWptDirectory(entry.name)) return;
    walkWptDirectory(`${dir}/${entry.name}`, out);
    return;
  }
  if (!entry.isFile()) return;
  const fullPath = `${dir}/${entry.name}`;
  const directoryPart = fullPath.slice(WPT_ROOT.length, -entry.name.length);
  addDiscoveredFile(out, fullPath, entry.name, directoryPart);
}

function walkWptDirectory(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) walkWptEntry(dir, entry, out);
}

/** @returns {string[]} */
export function discoverWptTests(prefix) {
  const root = resolve(WPT_ROOT, prefix);
  if (!existsSync(root)) {
    throw new Error(`prefix not found: .wpt/${prefix}`);
  }
  const out = [];
  walkWptDirectory(root, out);
  return out.sort();
}

function wptFileVariants(path, kind) {
  let src;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  if (kind === "html") {
    const re = /<meta\s+name=["']?variant["']?\s+content=["']([^"']*)["']/gi;
    let m;
    while ((m = re.exec(src))) out.push(m[1]);
  } else {
    const re = /^\/\/\s*META:\s*variant=(\S*)\s*$/gm;
    let m;
    while ((m = re.exec(src))) out.push(m[1]);
  }
  return out.filter((v) => v === "" || v.startsWith("?") || v.startsWith("#"));
}

/** @returns {string} */
export function referenceUrlForVariant(refHref, testPath) {
  // WPT loads a reference with the same query or fragment as its test variant.
  const at = testPath.search(/[?#]/);
  return at === -1 ? refHref : refHref + testPath.slice(at);
}

const REFTEST_DETECTION_PREFIX_BYTES = 8_192;

/** @returns {boolean} */
export function isReftestSource(testPath) {
  const path = resolve(WPT_ROOT, testPath.replace(/^\//, ""));
  if (!existsSync(path)) return false;
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(REFTEST_DETECTION_PREFIX_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    return /rel\s*=\s*["']?(match|mismatch)["']?/i.test(buf.toString("utf8", 0, n));
  } catch {
    return false;
  }
}
