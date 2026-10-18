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
    if (result.actual === "SKIP" && /--skip-slow/.test(result.reason ?? "")) {
      skipped++;
      continue;
    }
    const previous = expectations[result.test] ?? {};
    next[result.test] = { ...previous, expected: result.actual, reason: previous.reason ?? null };
  }
  return { next, skipped };
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

/** @returns {{pass: number, fail: number, other: number, total: number}} */
export function tallySubtests(results) {
  let pass = 0;
  let fail = 0;
  let other = 0;
  for (const r of results) {
    if (r.subtests && r.subtests.length > 0) {
      const real = r.subtests.filter(
        (s) => !(s.name && s.name.includes("synthesized from summary")),
      );
      for (const s of real) {
        if (s.status === "PASS") pass++;
        else if (s.status === "FAIL") fail++;
        else other++;
      }
      continue;
    }
    if (r.counts) {
      for (const [k, v] of Object.entries(r.counts)) {
        if (k === "PASS") pass += v;
        else if (k === "FAIL") fail += v;
        else other += v;
      }
    }
  }
  return { pass, fail, other, total: pass + fail + other };
}

/** @returns {{
 * total: number, expected: number, unexpectedFail: number,
 * unexpectedPass: number, byOutcome: Record<string, number>
 * }} */
export function summarize(results) {
  const KNOWN = ["PASS", "FAIL", "ERROR", "TIMEOUT", "CRASH", "SKIP"];
  const byOutcome = {};
  let unexpectedFail = 0;
  let unexpectedPass = 0;
  for (const r of results) {
    const oc = KNOWN.includes(r.actual) ? r.actual : "FAIL";
    byOutcome[oc] = (byOutcome[oc] || 0) + 1;
    if (r.unexpected) {
      if (r.expected !== "PASS" && r.actual === "PASS") unexpectedPass++;
      else unexpectedFail++;
    }
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

/** @returns {string} */
export function renderReportMd({ date, base, ws, summary, results }) {
  const lines = [];
  lines.push(`# Kitesurf WPT report — ${date}`);
  lines.push("");
  lines.push(`Base: \`${base}\`  ·  CDP: \`${ws}\``);
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Total tests run: **${summary.total}**`);
  lines.push(`- Matching expectations: **${summary.expected}**`);
  lines.push(`- Unexpected passes: **${summary.unexpectedPass}**`);
  lines.push(`- Unexpected failures/regressions: **${summary.unexpectedFail}**`);
  lines.push("");
  lines.push("By outcome:");
  for (const [k, v] of Object.entries(summary.byOutcome).sort()) {
    lines.push(`- \`${k}\`: ${v}`);
  }
  lines.push("");
  lines.push("## Tests");
  lines.push("");
  lines.push("| Status | Test | Expected | Actual | Notes |");
  lines.push("|---|---|---|---|---|");
  for (const r of results) {
    const tag = r.unexpected ? "❌" : r.actual === "PASS" ? "✓" : "·";
    let notes = "";
    if (r.reason) {
      notes = r.reason;
    } else if (r.harness?.status === "ERROR" && r.harness?.message) {
      notes = `harness ERROR: ${firstLine(r.harness.message)}`;
    } else if (r.counts) {
      notes = formatCounts(r.counts);
    }
    notes = notes.replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${tag} | \`${r.test}\` | ${r.expected} | ${r.actual} | ${notes} |`);
  }

  const nonPass = results.filter((r) => r.actual !== "PASS" && r.actual !== "SKIP");
  if (nonPass.length > 0) {
    lines.push("");
    lines.push("## Test details (non-PASS)");
    lines.push("");
    for (const r of nonPass) {
      lines.push(`### \`${r.test}\``);
      lines.push("");
      lines.push(`- **Outcome**: ${r.actual}${r.unexpected ? " (unexpected)" : ""}`);
      if (r.harness?.status) {
        lines.push(`- **Harness**: ${r.harness.status}`);
      }
      if (r.harness?.message) {
        lines.push("- **Harness message**:");
        lines.push("  ```");
        for (const line of String(r.harness.message).split("\n").slice(0, 8)) {
          lines.push(`  ${line}`);
        }
        lines.push("  ```");
      }
      const realSubtests = (r.subtests || []).filter(
        (s) => !s.name?.includes("synthesized from summary"),
      );
      if (realSubtests.length === 0) {
        if (r.counts) {
          lines.push(
            `- **Subtest counts**: ${formatCounts(r.counts)} (subtest names unavailable — testharness #results table didn't render)`,
          );
        }
        lines.push("");
        continue;
      }

      const failing = realSubtests.filter((s) => s.status !== "PASS");
      if (failing.length > 0) {
        lines.push(`- **Failing subtests** (${failing.length}/${realSubtests.length}):`);
        for (const s of failing.slice(0, 50)) {
          const msg = (s.message || "").replace(/\n/g, " ").slice(0, 200);
          lines.push(`  - **${s.status}** — ${s.name}${msg ? ` — ${msg}` : ""}`);
        }
        if (failing.length > 50) {
          lines.push(`  - … and ${failing.length - 50} more`);
        }
      }
      lines.push("");
    }
  }

  const md = lines.join("\n") + "\n";
  return md;
}

/** @typedef {{
 * mdPath: string, jsonPath: string,
 * latestMdPath: string | null, latestJsonPath: string | null, historyPath: string | null
 * }} ReportPaths */

/** @returns {ReportPaths} */
export function writeReport(results, summary, ctx) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const date = todayISO();
  const base = ctx?.base ?? DEFAULT_WPT_BASE;
  const ws = ctx?.ws ?? "";

  const md = renderReportMd({ date, base, ws, summary, results });
  const mdPath = resolve(REPORT_DIR, `${date}.md`);
  writeFileSync(mdPath, md);

  const json = {
    date,
    base,
    ws,
    commit: ctx?.commit ?? null,
    slice: ctx?.slice ?? null,
    summary,
    results,
  };
  const jsonPath = resolve(REPORT_DIR, `${date}.json`);
  writeFileSync(jsonPath, JSON.stringify(json, null, 2));

  let latestMdPath = null;
  let latestJsonPath = null;
  let historyPath = null;
  if (ctx?.record) {
    latestMdPath = resolve(REPORT_DIR, "latest.md");
    latestJsonPath = resolve(REPORT_DIR, "latest.json");
    writeFileSync(latestMdPath, md);
    writeFileSync(latestJsonPath, JSON.stringify(json, null, 2));

    const subtests = tallySubtests(results);
    const historyRow = {
      date: new Date().toISOString(),
      commit: ctx?.commit ?? null,
      slice: ctx?.slice ?? null,
      files: { ...summary.byOutcome },
      subtests,
    };
    historyPath = resolve(REPORT_DIR, "history.jsonl");
    appendFileSync(historyPath, JSON.stringify(historyRow) + "\n");
  }

  return { mdPath, jsonPath, latestMdPath, latestJsonPath, historyPath };
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

/** @returns {string[]} */
export function discoverWptTests(prefix) {
  const root = resolve(WPT_ROOT, prefix);
  if (!existsSync(root)) {
    throw new Error(`prefix not found: .wpt/${prefix}`);
  }
  const out = [];
  const skipDir = new Set(["resources", "support", "crashtests"]);
  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = `${dir}/${ent.name}`;
      if (ent.isDirectory()) {
        if (skipDir.has(ent.name)) continue;
        if (ent.name.startsWith(".")) continue;
        walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      const name = ent.name;
      if (/-ref(-[^/]*)?\.x?html?$/.test(name)) continue;
      if (/-notref\.x?html?$/.test(name)) continue;
      if (/-mismatch\.x?html?$/.test(name)) continue;
      if (name === "META.yml" || name === ".gitignore") continue;
      if (/\.(headers|ini|lock|md|yaml|yml|py)$/.test(name)) continue;
      let urlName = null;
      let variantSource = null;
      if (/\.html$/.test(name) || /\.xhtml$/.test(name) || /\.htm$/.test(name)) {
        if (!isRunnableWptDocument(full, name)) continue;
        urlName = name;
        variantSource = "html";
      } else if (/\.any\.js$/.test(name)) {
        urlName = name.replace(/\.any\.js$/, ".any.html");
        variantSource = "js";
      } else if (/\.window\.js$/.test(name)) {
        urlName = name.replace(/\.window\.js$/, ".window.html");
        variantSource = "js";
      } else {
        continue;
      }
      const rel = full.slice(WPT_ROOT.length);
      const dirPart = rel.slice(0, -name.length);
      const variants = wptFileVariants(full, variantSource);
      if (variants.length) {
        for (const v of variants) out.push(dirPart + urlName + v);
      } else {
        out.push(dirPart + urlName);
      }
    }
  }
  walk(root);
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
