// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import puppeteer from "puppeteer-core";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { PNG } from "pngjs";
import {
  TESTS_FILE,
  EXPECT_FILE,
  DEFAULT_WPT_BASE,
  loadJSON,
  referenceUrlForVariant,
  formatCounts,
  green,
  red,
  yellow,
  dim,
  bold,
} from "./wpt-shared.mjs";
import {
  TESTDRIVER_HOOK_SOURCE,
  createTestdriverBridge,
  attachTestdriverBinding,
} from "./wpt-testdriver.mjs";
import { getCachedRefScreenshot } from "./wpt-ref-cache.mjs";

const DEFAULT_WS = process.env.KITESURF_WS ?? "ws://127.0.0.1:8787/devtools/browser";
const DEFAULT_BASE = DEFAULT_WPT_BASE;
const DEFAULT_TIMEOUT_MS = 5_000;
const HARNESS_TIMEOUT_FLOOR_MS = 12_000;
// Expected TIMEOUT files need testharness's own verdict; explicit per-test budgets still win.
function budgetFor(expEntry) {
  if (expEntry?.timeout) return expEntry.timeout;
  return Math.max(TEST_TIMEOUT_MS, expEntry?.expected === "TIMEOUT" ? HARNESS_TIMEOUT_FLOOR_MS : 0);
}
const DEFAULT_MAX_TOTAL_MS = 0;
const TEST_HARD_DEADLINE_GRACE_MS = 5_000;
const STALL_BUDGET_EXTRA_GRACE_MS = 10_000;
const HOOK_INSTALL_BUDGET_MS = 10_000;
const HOOK_INSTALL_POLL_INTERVAL_MS = 25;
const REFTEST_READY_POLL_INTERVAL_MS = 25;
const CRASHTEST_POLL_INTERVAL_MS = 100;
const TESTHARNESS_SCRAPE_POLL_INTERVAL_MS = 150;
const ENGINE_RECOVERY_POLL_INTERVAL_MS = 2_000;

const args = process.argv.slice(2);
const argv = parseArgs(args);
const ENGINES = (argv.ws ?? [DEFAULT_WS]).map((ws, index) => ({
  index,
  ws,
  healthUrl: ws.replace(/^ws/, "http").replace(/\/devtools\/.*$/, "/health"),
  recoveryInFlight: null,
  dead: false,
}));
const WS = ENGINES[0].ws;
const WPT_BASE = argv.base ?? DEFAULT_BASE;
const TEST_TIMEOUT_MS = argv.timeout ?? DEFAULT_TIMEOUT_MS;
const MAX_TOTAL_MS = argv.maxTotal ?? DEFAULT_MAX_TOTAL_MS;
const SKIP_SLOW = argv.skipSlow ?? false;
const CONCURRENCY = Math.max(1, argv.concurrency ?? 1);
const JSON_OUT = argv.jsonOut ?? null;
const RECOVERY_BUDGET_MS = argv.recoveryBudget ?? 8_000;
const RERUN_CRASHES = argv.rerunCrashes !== false;
const PROFILE = process.env.WPT_PROFILE === "1";

const FORCE_RUN = new Set(argv.forceRunFile ? loadJSON(resolve(argv.forceRunFile), []) : []);

function isHelpOption(arg) {
  return arg === "--help" || arg === "-h";
}

function showHelp() {
  console.log(`Usage: node scripts/wpt-exec.mjs [options]

INTERNAL per-batch executor. Use \`pnpm run test:wpt\`
(scripts/wpt-batched.mjs) — it owns the test list, the engine, the
report and the expectations rebaseline.

  --ws <url>             CDP endpoint (default: ${DEFAULT_WS}). Repeatable:
                         lane i connects to the i-th endpoint (mod count),
                         so N endpoints + -j N is one lane per engine.
  --base <url>           WPT serve base (default: ${DEFAULT_BASE})
  --timeout <ms>         per-test timeout (default: ${DEFAULT_TIMEOUT_MS})
  --tests-file <path>    explicit test list (default: tests/wpt-tests.json)
  --json-out <path>      write the per-test result rows here for the
                         caller to aggregate. Without it the results
                         only reach stdout.
  --bail                 stop on first unexpected result
  --skip-slow            skip tests marked "slow": true in expectations.
                         Useful for fast slice cycles where slow tests
                         (>5s) would dominate the wall clock.
  --max-total <ms>       hard ceiling on total wall clock. Once
                         exceeded the runner stops dispatching new
                         tests, prints a partial summary, and exits
                         non-zero. Default: unlimited.
  -j, --concurrency <n>  run N lanes, each with its own puppeteer page;
                         per-page Page.navigate spins up its own
                         sub-isolate so tests stay isolated.
                         Lanes sharing ONE engine barely add
                         throughput (measured 1.12x for 6 lanes: the
                         parent isolate serialises them) — pass one
                         --ws per lane instead. Default: 1.
  --recovery-budget <ms> when /health stops answering AND the port is
                         refused (workerd gone), wait this long before
                         aborting the batch. Default: 8000.
  --stall-budget <ms>    when /health stops answering but the socket is
                         still accepted (engine alive, CPU-starved by a
                         hot test), wait this long instead. Reported as a
                         staller, not a killer, and the batch survives.
                         Default: slowest hard deadline in the run + 10s.
  --no-rerun-crashes     do NOT rerun CRASH/TIMEOUT/ERROR tests serially
                         at the end of the run. By default (and when
                         -j > 1), after the parallel pass any test
                         whose unexpected outcome was CRASH,
                         TIMEOUT, or ERROR is re-run once on a fresh single
                         lane to distinguish real failures from
                         collateral damage caused by a sibling
                         test taking workerd down. The rerun
                         result replaces the original.

  --skip-expected-timeouts  short-circuit any test with
                            expected: "TIMEOUT" in expectations.
                            Saves ~20s/test on a full run.
  --skip-expected-crashes   same idea for expected: "CRASH".
  --force-run-file <path>   JSON array of test paths exempt from the
                             two skip-expected short-circuits. CI feeds
                             the carried-regression ledger through this
                             so a skip-listed test's recovery is seen.
  --expectations <path>     read expectations from this path instead of
                             tests/wpt-expectations.json.
  --save-diff <dir>      for failing reftests, save test PNG, ref PNG,
                         and a diff PNG to <dir>. Filenames
                         derive from the test path with / replaced by _.
                         Useful for visually diagnosing systematic
                         rendering differences across a cluster.

Per-test "timeout" override in tests/wpt-expectations.json takes
precedence over --timeout. Use it for tests that genuinely need more
budget so the global --timeout can stay tight. Absent an override, a
test expected to TIMEOUT gets at least ${HARNESS_TIMEOUT_FLOOR_MS}ms so
testharness.js reaches its own 10s verdict and publishes the subtests
that passed before the hang, instead of reporting a bare 0/0.
`);
  process.exit(0);
}

function argumentHandlers(out) {
  const values = new Map(
    Object.entries({
      "--ws": (value) => (out.ws ??= []).push(value),
      "--base": (value) => (out.base = value),
      "--timeout": (value) => (out.timeout = parseInt(value, 10)),
      "--json-out": (value) => (out.jsonOut = value),
      "--max-total": (value) => (out.maxTotal = parseInt(value, 10)),
      "--concurrency": (value) => (out.concurrency = parseInt(value, 10)),
      "-j": (value) => (out.concurrency = parseInt(value, 10)),
      "--recovery-budget": (value) => (out.recoveryBudget = parseInt(value, 10)),
      "--stall-budget": (value) => (out.stallBudget = parseInt(value, 10)),
      "--force-run-file": (value) => (out.forceRunFile = value),
      "--expectations": (value) => (out.expectations = value),
      "--save-diff": (value) => (out.saveDiff = value),
      "--tests-file": (value) => (out.testsFile = value),
    }),
  );
  const flags = new Map(
    Object.entries({
      "--bail": () => (out.bail = true),
      "--skip-slow": () => (out.skipSlow = true),
      "--no-rerun-crashes": () => (out.rerunCrashes = false),
      "--skip-expected-timeouts": () => (out.skipExpectedTimeouts = true),
      "--skip-expected-crashes": () => (out.skipExpectedCrashes = true),
    }),
  );
  return { values, flags };
}

function parseArgs(arr) {
  const out = {};
  const { values, flags } = argumentHandlers(out);
  for (let i = 0; i < arr.length; i++) {
    const arg = arr[i];
    if (isHelpOption(arg)) showHelp();
    const valueHandler = values.get(arg);
    if (valueHandler) {
      valueHandler(arr[++i]);
      continue;
    }
    const flagHandler = flags.get(arg);
    if (flagHandler) flagHandler();
  }
  return out;
}

const HOOK_SOURCE =
  String.raw`
(() => {
  globalThis.__ks_wpt_result = null;
  globalThis.__ks_wpt_error = null;

  // Disable testharness's #results table render. For mega-test files
  // (Range-set.html has 10920 subtests), rendering 10920 rows × DOM
  // mutations through wasm is the wall-clock bottleneck — it blocks
  // the isolate for 60+ seconds even after all tests have already
  // run. add_completion_callback still fires first (it runs at the
  // top of notify_complete, before the renderer), so we get every
  // subtest's name + status + message via the JS hook below; the
  // DOM table that the renderer would have produced is redundant.
  //
  // testharness.js loads AFTER this hook (we inject as the first
  // classic script via Page.addScriptToEvaluateOnNewDocument). To
  // intercept testharness's setup() before any test() registers, we
  // install an accessor pair on globalThis that captures the real
  // setup assignment and immediately calls it with {output: false}.
  // testharness's "var setup = ..." in its IIFE doesn't go through
  // this — but its public installer ('globalThis.setup = setup')
  // does. WPT also exposes 'window.setup' directly.
  // Disable testharness's #results table render before the first
  // test() runs. Strategy: intercept testharness's registration of
  // 'setup' AND 'test' as global accessors. When user code first
  // CALLS test() (which triggers Output.init via tests.start →
  // notify_start), we call setup({output: false}) FIRST — at that
  // moment 'tests' is fully initialized AND Output's phase is
  // still INITIAL, so Output.setup can flip enabled=false. From
  // that point on show_results returns early without rendering
  // the 10920-row results table.
  //
  // For mega-test files (Range-set.html) the render itself was
  // the wall-clock bottleneck (~5ms per DOM op × 109k ops). With
  // output disabled, add_completion_callback still fires and we
  // capture results via the JS hook below.
  let _setup;
  let _outputDisabled = false;
  const disableOutputOnce = () => {
    if (_outputDisabled) return;
    _outputDisabled = true;
    try { _setup && _setup({ output: false }); } catch {}
  };
  // Registering the completion callback and disabling output are the
  // same moment: user code is about to touch the harness, so 'tests'
  // is initialized and nothing has completed yet.
  const harnessTouched = () => {
    disableOutputOnce();
    installHook();
  };
  try {
    Object.defineProperty(globalThis, "setup", {
      get() { installHook(); return _setup; },
      set(fn) { _setup = fn; },
      configurable: true,
    });
  } catch {}
  // Same trick for test, async_test, promise_test, generate_tests and
  // done. The first call to any of these triggers
  // tests.push -> tests.start -> add_start_callback -> Output.init,
  // moving Output's phase to STARTED. We slip a setup() call in
  // before that path. The getter intercepts the lookup; the setter
  // captures testharness's assignment.
  for (const name of ["test", "async_test", "promise_test", "generate_tests", "done"]) {
    let _impl;
    const propName = name;
    try {
      Object.defineProperty(globalThis, propName, {
        get() {
          if (_impl) harnessTouched();
          return _impl;
        },
        set(fn) { _impl = fn; },
        configurable: true,
      });
    } catch {}
  }

  // Capture testharness's own 'add_completion_callback' the instant it
  // exposes it, so registration never depends on a poll landing inside
  // the window between testharness.js executing and the load event.
  // That window is a couple of milliseconds on a local WPT server, and
  // a 25ms tick loses it — which is exactly what happened when the load
  // drain stopped paying a real timer turn per quiet poll: every
  // testharness test in the suite went TIMEOUT at once because the
  // callback landed AFTER completion had already run.
  //
  // We cannot call it at assignment time: 'expose(add_completion_callback)'
  // runs while testharness's own 'var tests = new Tests()' is still
  // undefined, so the call would throw. Hence the accessors above drive
  // the actual registration, and the tick below stays as a backstop for
  // files that never touch a global we intercept.
  let _acc;
  try {
    Object.defineProperty(globalThis, "add_completion_callback", {
      get() { return _acc; },
      set(fn) { _acc = fn; },
      configurable: true,
    });
  } catch {}

  let _hookInstalled = false;
  const installHook = () => {
    if (_hookInstalled) return true;
    const acc = _acc || globalThis.add_completion_callback;
    if (typeof acc !== "function") return false;
    // Throws if testharness's 'tests' is not constructed yet — stay
    // uninstalled and let a later trigger retry.
    try {
      acc(onComplete);
    } catch {
      return false;
    }
    _hookInstalled = true;
    return true;
  };

  function onComplete(tests, harness) {
    try {
      globalThis.__ks_wpt_result = {
        harness: {
          status: harness && typeof harness.status === "number" ? harness.status : -1,
          message: harness ? harness.message ?? null : null,
        },
        subtests: (tests || []).map((t) => ({
          name: String(t.name ?? ""),
          status: typeof t.status === "number" ? t.status : -1,
          message: t.message ?? null,
          stack: t.stack ?? null,
        })),
      };
    } catch (e) {
      globalThis.__ks_wpt_error = String(e && e.stack || e);
    }
  }

  const start = Date.now();
  const tick = () => {
    if (installHook()) return;
    if (Date.now() - start > ${HOOK_INSTALL_BUDGET_MS}) return;
    setTimeout(tick, ${HOOK_INSTALL_POLL_INTERVAL_MS});
  };
  tick();

  globalThis.addEventListener?.("error", (e) => {
    if (!globalThis.__ks_wpt_error) globalThis.__ks_wpt_error = String(e && e.message || e);
  });
})();
` + TESTDRIVER_HOOK_SOURCE;

const SCRAPER_SOURCE = String.raw`
(() => {
  // Fast path: if the pre-navigate hook fired, use it.
  if (globalThis.__ks_wpt_result) {
    return { source: "hook", value: globalThis.__ks_wpt_result };
  }

  const doc = globalThis.document;
  if (!doc) return null;

  // testharness.js writes results into <div id="log"> ... </div>.
  // #summary appears first, then #results. If #summary shows
  // ERROR/TIMEOUT/PRECONDITION_FAILED, no #results is emitted —
  // those are valid terminal states.
  const log = doc.getElementById("log");
  if (!log) return null;

  const summary = doc.getElementById("summary");
  if (!summary) return null;

  // Extract harness status: <p>Harness status: <span class="ok">OK</span></p>
  // The first <span> in #summary is the harness-status span (testharness
  // emits other <span>s for per-status pass/fail counts after it).
  const statusSpan = summary.querySelector("span");
  if (!statusSpan) return null;
  const harnessText = (statusSpan.textContent || "").trim();
  if (!harnessText) return null;

  const subtests = [];
  const resultsTable = doc.getElementById("results");
  if (resultsTable) {
    const rows = resultsTable.querySelectorAll("tbody > tr");
    for (const tr of rows) {
      const cells = tr.querySelectorAll("td");
      if (cells.length < 2) continue;
      const status = (cells[0].textContent || "").trim();
      const name = (cells[1].textContent || "").trim();
      // The message cell has a <pre> for stack; textContent flattens both.
      const messageCell = cells[cells.length - 1];
      const message = messageCell
        ? (messageCell.textContent || "").trim() || null
        : null;
      subtests.push({ name, status, message });
    }
  }

  // Fallback: when #results is missing (e.g. kitesurf's wasm DOM
  // doesn't currently render the table testharness builds via the
  // template render pipeline) we recover per-status counts from the
  // summary's checkbox labels. The summary contains
  //   <div><label><input>N <span class="pass">Pass</span></label></div>
  //   <div><label><input>M <span class="fail">Fail</span></label></div>
  // and similar. We expose the counts on the payload directly — the
  // runner uses them to classify and render. We deliberately do NOT
  // synthesize one fake subtest per count: that floods reports with
  // hundreds of meaningless rows. The cost is opacity (we know N
  // assertions failed but not which); the upside is reports stay
  // legible. Real per-subtest names land when #results renders, which
  // is a separate fix in the wasm DOM / shim.
  let counts = null;
  if (subtests.length === 0) {
    counts = {};
    const labels = summary.querySelectorAll("label");
    for (const label of labels) {
      const labelSpan = label.querySelector("span");
      if (!labelSpan) continue;
      const status = (labelSpan.textContent || "").trim().toUpperCase();
      const text = (label.textContent || "").trim();
      const m = text.match(/^(\d+)\s+/);
      if (!m) continue;
      const count = parseInt(m[1], 10);
      if (!isNaN(count) && count > 0 && status) {
        counts[status] = (counts[status] || 0) + count;
      }
    }
  }

  // Pull the harness error message out of any <pre> in #summary —
  // testharness emits the thrown error there when harness status is
  // ERROR. This is the most actionable single piece of data for
  // erroring tests and worth surfacing in the report.
  let harnessMessage = null;
  if (harnessText.toUpperCase() === "ERROR") {
    const pre = summary.querySelector("pre");
    if (pre) {
      const txt = (pre.textContent || "").trim();
      if (txt) harnessMessage = txt.slice(0, 500);
    }
  }

  return {
    source: counts ? "summary-counts" : "dom",
    value: {
      harness: { status: harnessText, message: harnessMessage },
      subtests,
      counts,
    },
  };
})()`;

function normalizeHarness(s) {
  if (typeof s === "string") return s.toUpperCase();
  return { 0: "OK", 1: "ERROR", 2: "TIMEOUT", 3: "PRECONDITION_FAILED" }[s] ?? `UNKNOWN(${s})`;
}
function normalizeSubtest(s) {
  if (typeof s === "string") return s.toUpperCase();
  return (
    { 0: "PASS", 1: "FAIL", 2: "TIMEOUT", 3: "NOTRUN", 4: "PRECONDITION_FAILED" }[s] ??
    `UNKNOWN(${s})`
  );
}

function classifyResult(harnessStatus, subtests, counts) {
  if (harnessStatus !== "OK") return classifyHarnessFailure(harnessStatus);
  if (counts && Object.keys(counts).length > 0) return classifyCounts(counts);
  if (subtests.length === 0) return "PASS";
  return classifySubtests(subtests);
}

function classifyHarnessFailure(harnessStatus) {
  return harnessStatus === "TIMEOUT" ? "TIMEOUT" : "ERROR";
}

function classifyCounts(counts) {
  const statuses = Object.keys(counts);
  return statuses.length === 1 && statuses[0] === "PASS" ? "PASS" : "FAIL";
}

function classifySubtests(subtests) {
  return subtests.every((subtest) => subtest.status === "PASS") ? "PASS" : "FAIL";
}

function withDeadline(label, ms, work) {
  // This bounds waiting for CDP, but it does not cancel the underlying page operation.
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ kind: "deadline", label, ms });
    }, ms);
    work().then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ kind: "ok", value });
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ kind: "err", err });
      },
    );
  });
}

// This executor follows only the first reference link; nested reftest chains are not traversed.
async function detectReftest(page) {
  return await page.evaluate(`(() => {
    const sel = '[rel="match"], [rel="mismatch"]';
    let links = document.querySelectorAll('link[rel="match"], link[rel="mismatch"]');
    if (links.length === 0) links = document.querySelectorAll(sel);
    if (links.length === 0) return null;
    const link = links[0];
    const raw = link.getAttribute('href');
    let href = link.href;
    if (typeof href !== 'string' || !href) {
      try { href = new URL(raw, document.baseURI).href; } catch { href = raw; }
    }
    // Same namespace-prefix trap as the link: SVG documents declare
    // <h:meta name="fuzzy">, an element literally named "h:meta" that a
    // 'meta' type selector misses. Fall back on the attribute, gated to
    // *meta-named elements so a stray [name=fuzzy] control can't match.
    let fuzzyEl = document.querySelector('meta[name="fuzzy"]');
    if (!fuzzyEl) {
      fuzzyEl = Array.from(document.querySelectorAll('[name="fuzzy"]'))
        .find((el) => String(el.localName || '').toLowerCase().endsWith('meta')) || null;
    }
    return {
      rel: link.getAttribute('rel'),
      href,
      fuzzy: fuzzyEl ? fuzzyEl.getAttribute('content') : null,
      waiting: document.documentElement.classList.contains('reftest-wait'),
    };
  })()`);
}

async function waitForReftestReady(page, deadline) {
  while (Date.now() < deadline) {
    let waiting = false;
    try {
      waiting = await page.evaluate(`document.documentElement.classList.contains("reftest-wait")`);
    } catch {
      return false;
    }
    if (!waiting) return true;
    await new Promise((r) => setTimeout(r, REFTEST_READY_POLL_INTERVAL_MS));
  }
  return false;
}

function fuzzyUpperBound(value) {
  const range = value.split("-");
  return parseInt(range[range.length - 1], 10) || 0;
}

function fuzzyFieldParts(field, firstField, maxDiff) {
  const equals = field.indexOf("=");
  if (equals !== -1) {
    return { key: field.slice(0, equals).trim(), value: field.slice(equals + 1).trim() };
  }
  const key = maxDiff === 0 && firstField ? "maxDifference" : "totalPixels";
  return { key, value: field };
}

function parseFuzzyFields(fields) {
  let maxDiff = 0;
  let maxPixels = 0;
  for (const field of fields) {
    const parts = fuzzyFieldParts(field, fields.indexOf(field) === 0, maxDiff);
    const upper = fuzzyUpperBound(parts.value);
    if (/^maxDifference$/i.test(parts.key)) maxDiff = upper;
    else if (/^totalPixels$/i.test(parts.key)) maxPixels = upper;
  }
  return { maxDiff, maxPixels };
}

function parseFuzzy(spec) {
  if (!spec) return { maxDiff: 0, maxPixels: 0 };
  const normalized = String(spec)
    .replace(/^[^[]*\[/, "")
    .replace(/\]$/, "")
    .trim();
  const fields = normalized
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  // WPT fuzzy ranges use their upper bound as the accepted tolerance.
  return parseFuzzyFields(fields);
}

async function captureScreenshotPng(page, _timeoutMs) {
  const buf = await page.screenshot({ type: "png", fullPage: false });
  return Buffer.from(buf);
}

// Raster quantization needs a one-level floor even when the WPT tolerance is zero.
const MAX_DIFF_FLOOR = 1;

function byteEqualComparison(isMismatch) {
  return {
    match: !isMismatch,
    diffPixels: 0,
    totalPixels: 0,
    reason: isMismatch ? "byte-equal but mismatch expected" : "byte-equal",
  };
}

function decodePngPair(testPng, refPng) {
  try {
    return { testImg: PNG.sync.read(testPng), refImg: PNG.sync.read(refPng) };
  } catch (e) {
    return {
      failure: {
        match: false,
        diffPixels: -1,
        totalPixels: 0,
        reason: `png decode failed: ${e.message}`,
      },
    };
  }
}

function dimensionMismatch(testImg, refImg) {
  if (testImg.width === refImg.width && testImg.height === refImg.height) return null;
  return {
    match: false,
    diffPixels: -1,
    totalPixels: 0,
    reason: `size mismatch: test=${testImg.width}x${testImg.height} ref=${refImg.width}x${refImg.height}`,
  };
}

function diffPngPixels(testImg, refImg, maxDiff) {
  const { width, height } = testImg;
  const diffData = Buffer.alloc(width * height * 4);
  const a = testImg.data;
  const b = refImg.data;
  let diffPixels = 0;
  let worstDelta = 0;
  // WPT counts a pixel when any RGBA channel exceeds maxDifference; it does not use YIQ distance.
  for (let i = 0; i < a.length; i += 4) {
    const dr = Math.abs(a[i] - b[i]);
    const dg = Math.abs(a[i + 1] - b[i + 1]);
    const db = Math.abs(a[i + 2] - b[i + 2]);
    const da = Math.abs(a[i + 3] - b[i + 3]);
    const delta = Math.max(dr, dg, db, da);
    if (delta > worstDelta) worstDelta = delta;
    if (delta > maxDiff) {
      diffPixels++;
      diffData[i] = 255;
      diffData[i + 3] = 255;
    } else {
      const grey = (a[i] + a[i + 1] + a[i + 2]) / 3;
      const faded = 255 - (255 - grey) * 0.1;
      diffData[i] = diffData[i + 1] = diffData[i + 2] = faded;
      diffData[i + 3] = 255;
    }
  }
  return { width, height, diffData, diffPixels, worstDelta };
}

function pixelComparison(fuzzy, isMismatch, pixelDiff) {
  const { width, height, diffData, diffPixels, worstDelta } = pixelDiff;
  const totalPixels = width * height;
  const match = isMismatch ? diffPixels > 0 : diffPixels <= fuzzy.maxPixels;
  const maxDiff = Math.max(fuzzy.maxDiff, MAX_DIFF_FLOOR);
  const floored = maxDiff !== fuzzy.maxDiff ? `, floor=${MAX_DIFF_FLOOR}` : "";
  const detail =
    `pixel-diff=${diffPixels}/${totalPixels} worstDelta=${worstDelta} ` +
    `fuzzy(maxDiff=${fuzzy.maxDiff}${floored}, maxPixels=${fuzzy.maxPixels})` +
    `${isMismatch ? " [mismatch]" : ""}`;
  return {
    match,
    diffPixels,
    totalPixels,
    width,
    height,
    diffData,
    reason: match ? `${detail} within tolerance` : `${detail} exceeds tolerance`,
  };
}

function comparePngs(testPng, refPng, fuzzy, isMismatch) {
  if (testPng.equals(refPng)) return byteEqualComparison(isMismatch);
  const decoded = decodePngPair(testPng, refPng);
  if (decoded.failure) return decoded.failure;
  const { testImg, refImg } = decoded;
  const sizeFailure = dimensionMismatch(testImg, refImg);
  if (sizeFailure) return sizeFailure;
  const maxDiff = Math.max(fuzzy.maxDiff, MAX_DIFF_FLOOR);
  return pixelComparison(fuzzy, isMismatch, diffPngPixels(testImg, refImg, maxDiff));
}

const refShotCache = new Map();
let refShotHits = 0;

async function runReftest(page, testInfo, timeoutMs, deadline, lap = () => {}) {
  const fuzzy = parseFuzzy(testInfo.fuzzy);
  const isMismatch = testInfo.rel === "mismatch";
  // Print and screen references differ, so media belongs in the reference-cache key.
  const cacheKey = `${testInfo.media ?? ""}\n${testInfo.href}`;

  const testCapture = await captureReftestTestPng(page, testInfo, timeoutMs, deadline, lap);
  if (testCapture.failure) return testCapture.failure;
  lap("refShot1Ms");
  const refCapture = await loadReferenceScreenshot(page, testInfo, cacheKey, timeoutMs, lap);
  if (refCapture.failure) return refCapture.failure;
  const cmp = comparePngs(testCapture.png, refCapture.png, fuzzy, isMismatch);
  lap("refCompareMs");
  saveReftestDiff(cmp, testInfo, testCapture.png, refCapture.png);
  return reftestResult(testInfo, fuzzy, cmp, refCapture.cached);
}

function reftestResult(testInfo, fuzzy, cmp, refCached) {
  return {
    actual: cmp.match ? "PASS" : "FAIL",
    reason: `reftest [${testInfo.rel}] ${cmp.reason}${refCached ? " (ref cached)" : ""}`,
    subtests: [],
    source: "reftest",
    reftest: {
      rel: testInfo.rel,
      href: testInfo.href,
      fuzzy,
      diffPixels: cmp.diffPixels,
      totalPixels: cmp.totalPixels,
      refCached,
    },
  };
}

async function captureReftestTestPng(page, testInfo, timeoutMs, deadline, lap) {
  if (testInfo.waiting) await waitForReftestReady(page, deadline);
  lap("refWaitMs");
  try {
    return { png: await captureScreenshotPng(page, timeoutMs) };
  } catch (e) {
    return {
      failure: { actual: "ERROR", reason: `test screenshot failed: ${e.message}`, subtests: [] },
    };
  }
}

async function renderReferenceScreenshot(page, testInfo, timeoutMs, lap) {
  try {
    await page.goto(testInfo.href, { timeout: timeoutMs });
  } catch (e) {
    throw { actual: "ERROR", reason: `ref goto failed: ${e.message}`, subtests: [] };
  }
  lap("refGotoMs");
  // If a reference stays in reftest-wait, capture its current frame but do not cache it.
  const cacheable = await waitForReftestReady(page, Date.now() + timeoutMs);
  lap("refWaitMs");
  let png;
  try {
    png = await captureScreenshotPng(page, timeoutMs);
  } catch (e) {
    throw { actual: "ERROR", reason: `ref screenshot failed: ${e.message}`, subtests: [] };
  }
  lap("refShot2Ms");
  return { png, cacheable };
}

function isReftestFailure(err) {
  return Boolean(err && typeof err === "object" && err.actual);
}

async function loadReferenceScreenshot(page, testInfo, cacheKey, timeoutMs, lap) {
  try {
    const reference = await getCachedRefScreenshot(refShotCache, cacheKey, () =>
      renderReferenceScreenshot(page, testInfo, timeoutMs, lap),
    );
    if (reference.cached) {
      refShotHits++;
      lap("refCacheWaitMs");
    }
    return reference;
  } catch (err) {
    if (isReftestFailure(err)) return { failure: err };
    throw err;
  }
}

function saveReftestDiff(cmp, testInfo, testPng, refPng) {
  if (cmp.match || !argv.saveDiff || !cmp.diffData) return;
  try {
    mkdirSync(argv.saveDiff, { recursive: true });
    const safe = testInfo.testPath.replace(/^\//, "").replace(/[\/]/g, "_");
    writeFileSync(resolve(argv.saveDiff, `${safe}.test.png`), testPng);
    writeFileSync(resolve(argv.saveDiff, `${safe}.ref.png`), refPng);
    const diffPng = new PNG({ width: cmp.width, height: cmp.height });
    cmp.diffData.copy(diffPng.data);
    const out = PNG.sync.write(diffPng);
    writeFileSync(resolve(argv.saveDiff, `${safe}.diff.png`), out);
  } catch {}
}

async function runCrashTest(page, testPath, deadline) {
  const probe = `(() => {
    const de = document.documentElement;
    return { waiting: !!de && de.classList.contains("test-wait"),
             path: location.pathname };
  })()`;
  const testUrlPath = new URL(`${WPT_BASE}${testPath}`).pathname;
  let last = null;
  while (Date.now() < deadline) {
    const result = await probeCrashPage(page, probe);
    if (result.failure) return result.failure;
    last = result.value;
    if (crashTestLoaded(last, testUrlPath)) return crashTestPass();
    await sleep(CRASHTEST_POLL_INTERVAL_MS);
  }
  return crashTestTimeout(last);
}

async function probeCrashPage(page, probe) {
  try {
    return { value: await page.evaluate(probe) };
  } catch (e) {
    return {
      failure: {
        actual: "CRASH",
        reason: `page unreachable: ${e.message}`,
        subtests: [],
        source: "crashtest",
      },
    };
  }
}

function crashTestLoaded(last, testUrlPath) {
  return last && last.path === testUrlPath && !last.waiting;
}

function crashTestPass() {
  return {
    actual: "PASS",
    reason: "crashtest: loaded without crashing",
    subtests: [],
    source: "crashtest",
  };
}

function crashTestTimeout(last) {
  return {
    actual: "TIMEOUT",
    reason: last?.waiting
      ? "crashtest: test-wait never cleared"
      : "crashtest: navigate never settled",
    subtests: [],
    source: "crashtest",
  };
}

function createProfile() {
  return PROFILE ? { phases: {}, scrapeIters: 0 } : null;
}

function createLap(prof) {
  let lapT = Date.now();
  return (name) => {
    if (!prof) return;
    const now = Date.now();
    prof.phases[name] = (prof.phases[name] ?? 0) + (now - lapT);
    lapT = now;
  };
}

function withProfile(prof, result) {
  return prof ? { ...result, profile: prof } : result;
}

function skipExpectedTimeout(testPath, expected) {
  if (expected !== "TIMEOUT" || !argv.skipExpectedTimeouts || FORCE_RUN.has(testPath)) return null;
  return {
    actual: "TIMEOUT",
    reason: "expected TIMEOUT (--skip-expected-timeouts)",
    subtests: [],
    synthetic: true,
  };
}

function skipExpectedCrash(testPath, expected) {
  if (expected !== "CRASH" || !argv.skipExpectedCrashes || FORCE_RUN.has(testPath)) return null;
  return {
    actual: "CRASH",
    reason: "expected CRASH (--skip-expected-crashes)",
    subtests: [],
    synthetic: true,
  };
}

function wantsPrintMedia(testPath) {
  return (
    /-print(?:-ref)?(?:\.tentative)?\.html$/.test(testPath) || testPath.startsWith("/css/printing/")
  );
}

function isCrashTest(testPath) {
  return /-crash(?:\.[\w-]+)*\.x?html?$/.test(testPath) || testPath.includes("/crashtests/");
}

function isExpectedPageLocation(page, expectedUrlLocation) {
  try {
    const liveUrl = new URL(page.url());
    return liveUrl.pathname + liveUrl.search === expectedUrlLocation;
  } catch {
    return false;
  }
}

function createPageErrorHandler(page, expectedUrlLocation, reportError) {
  return (error) => {
    if (!isExpectedPageLocation(page, expectedUrlLocation)) return;
    reportError(error);
  };
}

async function applyPrintMedia(page, printMedia, lap) {
  try {
    const session = await page.target().createCDPSession();
    // Apply print media before navigation so its rules affect the first render.
    await session.send("Emulation.setEmulatedMedia", { media: printMedia ? "print" : "" });
    await session.detach();
  } catch {}
  lap("mediaMs");
}

function resetTestdriverBridge(bridge) {
  try {
    bridge?.reset();
  } catch {}
}

async function navigateTest(page, url, timeoutMs, lap) {
  await page.goto(url, { timeout: timeoutMs }).catch(() => {});
  lap("gotoMs");
}

function firstNavigateProfile(result) {
  const byTarget = result?.byTarget ?? {};
  return Object.values(byTarget).find((entry) => entry && typeof entry === "object") ?? null;
}

async function recordNavigateProfile(prof, profSession, lap) {
  if (!(prof && profSession)) return;
  try {
    const result = await profSession.send("Kitesurf.getNavigatePhases", {});
    prof.engine = firstNavigateProfile(result);
  } catch {}
  lap("profOverheadMs");
}

async function runCrashTestIfNeeded(context) {
  if (!context.crashTest) return null;
  const result = await runCrashTest(context.page, context.testPath, context.t0 + context.timeoutMs);
  context.lap("crashPollMs");
  return { crashTestResult: result };
}

async function runReftestIfPresent(context) {
  let reftest = null;
  try {
    reftest = await detectReftest(context.page);
  } catch {}
  context.lap("detectMs");
  if (!reftest) return null;
  reftest.testPath = context.testPath;
  reftest.href = referenceUrlForVariant(reftest.href, context.testPath);
  reftest.media = context.printMedia ? "print" : "";
  return {
    reftestResult: await runReftest(
      context.page,
      reftest,
      context.timeoutMs,
      context.t0 + context.timeoutMs,
      context.lap,
    ),
  };
}

async function readTestHarness(page, prof, lap) {
  if (prof) prof.scrapeIters++;
  let scraped = null;
  try {
    scraped = await page.evaluate(SCRAPER_SOURCE);
  } catch {}
  lap("scrapeEvalMs");
  return scraped;
}

async function hasExpectedPagePath(page, testUrlPath, lap) {
  let livePath = null;
  try {
    livePath = await page.evaluate(`location.pathname`);
  } catch {}
  lap("pathCheckMs");
  // Reused pages may retain an old #log; reject readable pathname mismatches only.
  return !livePath || livePath === testUrlPath;
}

async function drainTestdriverBridge(bridge, lap) {
  try {
    await bridge?.drain();
  } catch {}
  lap("drainMs");
}

async function readWptError(page) {
  try {
    return await page.evaluate(`globalThis.__ks_wpt_error`);
  } catch {
    return null;
  }
}

async function collectTestHarness(context) {
  const scrapeDeadline = context.t0 + context.timeoutMs;
  while (Date.now() < scrapeDeadline) {
    const scraped = await readTestHarness(context.page, context.prof, context.lap);
    if (
      scraped &&
      scraped.value &&
      (await hasExpectedPagePath(context.page, context.testUrlPath, context.lap))
    ) {
      return { payload: scraped.value, source: scraped.source };
    }
    await drainTestdriverBridge(context.bridge, context.lap);
    await sleep(TESTHARNESS_SCRAPE_POLL_INTERVAL_MS);
    context.lap("scrapeSleepMs");
  }
  return { payload: null, errInfo: await readWptError(context.page) };
}

async function executePageTest(context) {
  await applyPrintMedia(context.page, context.printMedia, context.lap);
  resetTestdriverBridge(context.bridge);
  await navigateTest(context.page, context.url, context.timeoutMs, context.lap);
  await recordNavigateProfile(context.prof, context.profSession, context.lap);
  const crashResult = await runCrashTestIfNeeded(context);
  if (crashResult) return crashResult;
  const reftestResult = await runReftestIfPresent(context);
  if (reftestResult) return reftestResult;
  return collectTestHarness(context);
}

function testDeadlineResult(outcome, deadlineMs, prof) {
  if (outcome.kind !== "deadline") return null;
  return withProfile(prof, {
    actual: "TIMEOUT",
    reason: `hard deadline after ${deadlineMs}ms (likely goto or evaluate hung)`,
    subtests: [],
  });
}

function testErrorResult(outcome, prof) {
  if (outcome.kind !== "err") return null;
  return withProfile(prof, {
    actual: "CRASH",
    reason: String((outcome.err && outcome.err.message) || outcome.err),
    subtests: [],
  });
}

function specialTestResult(value) {
  if (value && value.reftestResult) return value.reftestResult;
  if (value && value.crashTestResult) return value.crashTestResult;
  return null;
}

function noHarnessResult(errInfo, pageError, timeoutMs, prof) {
  const error = pageError || errInfo;
  return withProfile(prof, {
    actual: error ? "ERROR" : "TIMEOUT",
    reason: error
      ? `no testharness results scraped (page error: ${error})`
      : `no testharness results scraped within ${timeoutMs}ms`,
    subtests: [],
  });
}

function harnessResult(payload, source, prof) {
  const harnessStatus = normalizeHarness(payload.harness.status);
  const subtests = payload.subtests.map((subtest) => ({
    name: subtest.name,
    status: normalizeSubtest(subtest.status),
    message: subtest.message,
  }));
  const counts = payload.counts ?? null;
  return withProfile(prof, {
    actual: classifyResult(harnessStatus, subtests, counts),
    reason: null,
    source,
    harness: { status: harnessStatus, message: payload.harness.message },
    subtests,
    counts,
  });
}

function payloadResult(value, pageError, timeoutMs, prof) {
  const { payload, source, errInfo } = value;
  if (!payload) return noHarnessResult(errInfo, pageError, timeoutMs, prof);
  return harnessResult(payload, source, prof);
}

function resultFromOutcome(outcome, pageError, timeoutMs, deadlineMs, prof) {
  const deadlineResult = testDeadlineResult(outcome, deadlineMs, prof);
  if (deadlineResult) return deadlineResult;
  const errorResult = testErrorResult(outcome, prof);
  if (errorResult) return errorResult;
  const specialResult = specialTestResult(outcome.value);
  if (specialResult) return withProfile(prof, specialResult);
  return payloadResult(outcome.value, pageError, timeoutMs, prof);
}

async function runOne(page, testPath, expected, perTestTimeoutMs, bridge, profSession) {
  if (expected === "SKIP") {
    return { actual: "SKIP", reason: "marked SKIP in expectations", subtests: [] };
  }
  const prof = createProfile();
  const lap = createLap(prof);
  const timeoutResult = skipExpectedTimeout(testPath, expected);
  if (timeoutResult) return timeoutResult;
  const crashResult = skipExpectedCrash(testPath, expected);
  if (crashResult) return crashResult;

  const url = `${WPT_BASE}${testPath}`;
  const timeoutMs = budgetFor({ timeout: perTestTimeoutMs, expected });
  const deadlineMs = timeoutMs + TEST_HARD_DEADLINE_GRACE_MS;
  const t0 = Date.now();
  const printMedia = wantsPrintMedia(testPath);
  const crashTest = isCrashTest(testPath);
  const expectedUrl = new URL(url);
  const testContext = {
    page,
    testPath,
    url,
    timeoutMs,
    t0,
    printMedia,
    crashTest,
    testUrlPath: expectedUrl.pathname,
    prof,
    profSession,
    bridge,
    lap,
  };
  let pageError = null;
  const onPageError = createPageErrorHandler(
    page,
    expectedUrl.pathname + expectedUrl.search,
    (error) => {
      if (!pageError) pageError = String((error && error.stack) || error);
    },
  );
  page.on("pageerror", onPageError);
  let outcome;
  try {
    outcome = await withDeadline("test", deadlineMs, () => executePageTest(testContext));
  } finally {
    page.off("pageerror", onPageError);
  }
  return resultFromOutcome(outcome, pageError, timeoutMs, deadlineMs, prof);
}

function loadRunInput() {
  const listFile = argv.testsFile ? resolve(argv.testsFile) : TESTS_FILE;
  if (!existsSync(listFile)) {
    console.error(red(`[wpt-exec] ${listFile} not found.`));
    process.exit(2);
  }
  const filtered = loadJSON(listFile, []);
  const expectations = loadJSON(argv.expectations ? resolve(argv.expectations) : EXPECT_FILE, {});
  if (filtered.length === 0) {
    console.error(red(`[wpt-exec] ${listFile} lists no tests`));
    process.exit(2);
  }
  return { filtered, expectations };
}

function connectionFailureCode(code) {
  return code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENOTFOUND";
}

function healthErrorCode(error) {
  return error?.cause?.code ?? error?.code;
}

function healthStateForError(error) {
  return connectionFailureCode(healthErrorCode(error)) ? "refused" : "stalled";
}

async function probeHealth(engine, timeoutMs = 2500) {
  try {
    const response = await fetch(engine.healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? "ok" : "stalled";
  } catch (error) {
    return healthStateForError(error);
  }
}

async function probeKitesurf(engine, timeoutMs = 2500) {
  return (await probeHealth(engine, timeoutMs)) === "ok";
}

const RECONNECT_ATTEMPTS = 4;
const RECONNECT_HEALTH_WAIT_BUDGET_MS = 10_000;
const RECONNECT_HEALTH_POLL_INTERVAL_MS = 500;
const RECONNECT_RETRY_BASE_DELAY_MS = 250;
const RECONNECT_RETRY_JITTER_MS = 500;
const RECONNECT_BUDGET_MS = 5000;

async function waitForReconnectHealth(engine) {
  const startedAt = Date.now();
  while (
    Date.now() - startedAt < RECONNECT_HEALTH_WAIT_BUDGET_MS &&
    !(await probeKitesurf(engine, 2000))
  ) {
    await sleep(RECONNECT_HEALTH_POLL_INTERVAL_MS);
  }
}

function reconnectRetryDelay(attempt) {
  return RECONNECT_RETRY_BASE_DELAY_MS * attempt + Math.random() * RECONNECT_RETRY_JITTER_MS;
}

async function retryReconnect(engine, once) {
  let lastErr;
  for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
    try {
      return await once();
    } catch (err) {
      lastErr = err;
      if (attempt < RECONNECT_ATTEMPTS) {
        await waitForReconnectHealth(engine);
        await sleep(reconnectRetryDelay(attempt));
      }
    }
  }
  throw lastErr;
}

async function verifyEngineHealth(engine) {
  if (await probeKitesurf(engine, 3000)) return;
  console.error(red(`[wpt-exec] cannot reach kitesurf health at ${engine.healthUrl}`));
  console.error(red(`         start it with: pnpm run dev`));
  console.error(red(`         (or wait — workerd may be restarting after a crash)`));
  process.exit(2);
}

async function verifyAllEngineHealth() {
  for (const engine of ENGINES) await verifyEngineHealth(engine);
}

function stallBudgetFor(filtered, expectations) {
  return (
    argv.stallBudget ??
    filtered.reduce(
      (maximum, test) =>
        Math.max(maximum, budgetFor(expectations[test]) + TEST_HARD_DEADLINE_GRACE_MS),
      0,
    ) + STALL_BUDGET_EXTRA_GRACE_MS
  );
}

function printRunConfiguration(filtered, stallBudgetMs) {
  console.log(
    dim(
      ENGINES.length === 1
        ? `[wpt-exec] connecting to ${WS}`
        : `[wpt-exec] connecting to ${ENGINES.length} engines: ${ENGINES.map((engine) => engine.ws).join(", ")}`,
    ),
  );
  console.log(
    dim(
      `[wpt-exec] running ${filtered.length} test(s) (timeout ${TEST_TIMEOUT_MS}ms each, concurrency ${CONCURRENCY})`,
    ),
  );
  console.log(
    dim(
      `[wpt-exec] health budgets: ${RECOVERY_BUDGET_MS}ms if the port is refused, ${stallBudgetMs}ms if it is merely starved`,
    ),
  );
  if (SKIP_SLOW) console.log(dim(`[wpt-exec] --skip-slow: skipping tests marked slow`));
  if (MAX_TOTAL_MS > 0) console.log(dim(`[wpt-exec] --max-total: ${MAX_TOTAL_MS}ms hard ceiling`));
  console.log("");
}

function createRunState(filtered, expectations, stallBudgetMs) {
  return {
    filtered,
    expectations,
    stallBudgetMs,
    results: new Array(filtered.length).fill(null),
    inFlight: new Map(),
    enginePossiblyKilled: new Set(),
    engineStalled: new Set(),
    unexpectedFail: 0,
    unexpectedPass: 0,
    byOutcome: {},
    runStart: Date.now(),
    truncated: false,
    aborted: false,
    bailRequested: false,
    queueCursor: 0,
  };
}

function maxTotalExpired(state) {
  return MAX_TOTAL_MS > 0 && Date.now() - state.runStart >= MAX_TOTAL_MS;
}

function reportMaxTotalReached(state) {
  if (state.truncated) return;
  state.truncated = true;
  console.log("");
  console.log(
    dim(
      `[wpt-exec] --max-total ${MAX_TOTAL_MS}ms reached; ${state.filtered.length - state.queueCursor} test(s) not run`,
    ),
  );
}

function takeQueuedTest(state) {
  if (state.queueCursor >= state.filtered.length) return null;
  const idx = state.queueCursor++;
  return { idx, testPath: state.filtered[idx] };
}

function nextTest(state) {
  if (state.aborted || state.bailRequested) return null;
  if (maxTotalExpired(state)) {
    reportMaxTotalReached(state);
    return null;
  }
  return takeQueuedTest(state);
}

function engineTag(engine) {
  return ENGINES.length > 1 ? `engine ${engine.index} ` : "";
}

function isRecovering(engine) {
  return engine.recoveryInFlight !== null;
}

function reportRecoveryStart(engine, triggerLaneTag) {
  console.log("");
  console.log(
    yellow(
      `[wpt-exec] ${triggerLaneTag}: kitesurf ${engineTag(engine)}health probe failed; waiting for recovery...`,
    ),
  );
}

function reportRecoverySuccess(engine, took, sawStall) {
  const how = sawStall ? " (was starved, never dead)" : "";
  console.log(
    green(`[wpt-exec] kitesurf ${engineTag(engine)}recovered after ${took}ms${how} — resuming`),
  );
}

function shouldExtendRecoveryBudget(probeState, sawStall) {
  return probeState === "stalled" && !sawStall;
}

function extendRecoveryBudget(engine, stallBudgetMs) {
  console.log(
    yellow(
      `[wpt-exec] /health accepted the socket but did not answer — ${engineTag(engine)}is starved, not dead; extending to ${Math.round(stallBudgetMs / 1000)}s`,
    ),
  );
  return stallBudgetMs;
}

function reportRecoveryFailure(engine, budget) {
  engine.dead = true;
  const alive = ENGINES.filter((candidate) => !candidate.dead).length;
  console.log(
    red(
      `[wpt-exec] kitesurf ${engineTag(engine)}did not recover within ${Math.round(budget / 1000)}s — ` +
        (alive > 0 ? `dropping its lane(s); ${alive} engine(s) still up` : `aborting batch`),
    ),
  );
  return false;
}

async function recoverEngine(state, engine, triggerLaneTag) {
  reportRecoveryStart(engine, triggerLaneTag);
  const startedAt = Date.now();
  let budget = RECOVERY_BUDGET_MS;
  let sawStall = false;
  while (Date.now() - startedAt < budget) {
    const probeState = await probeHealth(engine, 2000);
    if (probeState === "ok") {
      reportRecoverySuccess(engine, Date.now() - startedAt, sawStall);
      return true;
    }
    if (shouldExtendRecoveryBudget(probeState, sawStall)) {
      sawStall = true;
      budget = extendRecoveryBudget(engine, state.stallBudgetMs);
    }
    await sleep(ENGINE_RECOVERY_POLL_INTERVAL_MS);
  }
  return reportRecoveryFailure(engine, budget);
}

async function recoverWorker(state, engine, triggerLaneTag) {
  if (engine.recoveryInFlight) return engine.recoveryInFlight;
  engine.recoveryInFlight = recoverEngine(state, engine, triggerLaneTag);
  const recovered = await engine.recoveryInFlight;
  engine.recoveryInFlight = null;
  return recovered;
}

function formatUnexpectedResultLine(tag, path, ms, result, expected) {
  if (expected !== "PASS" && result.actual === "PASS") {
    return `  ${tag}${path} ${yellow("?PASS")} ${dim(`${ms}ms`)}  ${dim(`expected ${expected}, got PASS`)}`;
  }
  const reason = result.reason ? ` — ${result.reason.slice(0, 60)}` : "";
  return `  ${tag}${path} ${red("✗")} ${dim(`${ms}ms`)}  ${red(result.actual)} ${dim(`(expected ${expected})${reason}`)}`;
}

function formatExpectedResultLine(tag, path, ms, result, skippedAsSlow) {
  if (skippedAsSlow) return `  ${tag}${path} ${dim("⤵")} ${dim(`${ms}ms`)}  ${dim("SKIP (slow)")}`;
  const okTag = result.actual === "PASS" ? green("✓") : dim("·");
  const detail = result.counts ? dim(` (${formatCounts(result.counts)})`) : "";
  return `  ${tag}${path} ${okTag} ${dim(`${ms}ms`)}  ${dim(result.actual)}${detail}`;
}

function formatResultLine(laneTag, testPath, ms, result, expected, matched, skippedAsSlow) {
  const tag = laneTag ? `${dim(laneTag)} ` : "";
  const path = testPath.padEnd(60);
  if (!matched) return formatUnexpectedResultLine(tag, path, ms, result, expected);
  return formatExpectedResultLine(tag, path, ms, result, skippedAsSlow);
}

function createClient(engine, laneTag) {
  return { engine, laneTag, browser: null, page: null, bridge: null, profSession: null };
}

function createLane(laneId) {
  const laneTag = CONCURRENCY > 1 ? `[w${laneId}]` : "";
  return createClient(ENGINES[laneId % ENGINES.length], laneTag);
}

async function installClientBridge(client) {
  client.bridge = null;
  client.profSession = null;
  try {
    const session = await client.page.createCDPSession();
    client.bridge = createTestdriverBridge({ page: client.page, session });
    await attachTestdriverBinding(session, client.bridge);
    if (PROFILE) client.profSession = session;
  } catch {}
}

async function installClientHook(page) {
  try {
    await page.evaluateOnNewDocument(HOOK_SOURCE);
  } catch {}
}

async function connectClient(client) {
  client.browser = await puppeteer.connect({ browserWSEndpoint: client.engine.ws });
  client.page = await client.browser.newPage();
  await installClientHook(client.page);
  await installClientBridge(client);
}

async function disconnectClient(client) {
  try {
    await client.browser?.disconnect();
  } catch {}
}

function withReconnectTimeout(promise, label, remaining) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`reconnect ${label} timed out`)), remaining()),
    ),
  ]);
}

async function installReconnectHook(page, withTimeout) {
  try {
    await withTimeout(page.evaluateOnNewDocument(HOOK_SOURCE), "hook-install");
  } catch {}
}

async function reconnectClientOnce(client) {
  await disconnectClient(client);
  const startedAt = Date.now();
  const remaining = () => Math.max(0, RECONNECT_BUDGET_MS - (Date.now() - startedAt));
  const withTimeout = (promise, label) => withReconnectTimeout(promise, label, remaining);
  client.browser = await withTimeout(
    puppeteer.connect({ browserWSEndpoint: client.engine.ws }),
    "connect",
  );
  client.page = await withTimeout(client.browser.newPage(), "newPage");
  await installReconnectHook(client.page, withTimeout);
  await installClientBridge(client);
}

async function reconnectClient(client) {
  return retryReconnect(client.engine, () => reconnectClientOnce(client));
}

function shouldSkipSlowTest(isSlow) {
  return SKIP_SLOW && isSlow;
}

async function executeLaneTestResult(client, testPath, expected, timeout, isSlow) {
  if (shouldSkipSlowTest(isSlow)) {
    return { actual: "SKIP", reason: "slow (--skip-slow)", subtests: [] };
  }
  return runOne(client.page, testPath, expected, timeout, client.bridge, client.profSession);
}

function skippedAsSlow(isSlow, result) {
  return SKIP_SLOW && isSlow && result.actual === "SKIP";
}

function updateUnexpectedCounts(state, expected, result, matched) {
  if (matched) return false;
  if (expected !== "PASS" && result.actual === "PASS") {
    state.unexpectedPass++;
    return true;
  }
  state.unexpectedFail++;
  return true;
}

function laneResultRow(testPath, expected, result, ms, unexpected) {
  return {
    test: testPath,
    expected,
    actual: result.actual,
    reason: result.reason,
    subtests: result.subtests,
    counts: result.counts ?? null,
    harness: result.harness ?? null,
    durationMs: ms,
    unexpected,
    ...(result.profile ? { profile: result.profile } : {}),
  };
}

function recordLaneResult(client, state, item, expected, isSlow, startedAt, result) {
  const ms = Date.now() - startedAt;
  state.byOutcome[result.actual] = (state.byOutcome[result.actual] ?? 0) + 1;
  const wasSkippedAsSlow = skippedAsSlow(isSlow, result);
  const matched = result.actual === expected || wasSkippedAsSlow;
  const unexpected = updateUnexpectedCounts(state, expected, result, matched);
  console.log(
    formatResultLine(
      client.laneTag,
      item.testPath,
      ms,
      result,
      expected,
      matched,
      wasSkippedAsSlow,
    ),
  );
  state.results[item.idx] = laneResultRow(item.testPath, expected, result, ms, unexpected);
  return { ms, unexpected };
}

function requestBail(state, unexpected) {
  if (!argv.bail || !unexpected) return false;
  state.bailRequested = true;
  return true;
}

function recoverableResult(result) {
  return (result.actual === "TIMEOUT" || result.actual === "CRASH") && !result.synthetic;
}

function oldestTestOnEngine(state, engine) {
  return [...state.inFlight.values()]
    .filter((flight) => flight.engine === engine)
    .sort((left, right) => left.startedAt - right.startedAt)[0];
}

function reportEngineBlame(client, current, blame, recovered, state) {
  const via = blame.testPath === current.testPath ? "" : ` (noticed by ${current.testPath})`;
  const reason = recovered
    ? `starved the engine past the 2s health probe${via} — recovered, not a killer`
    : `took the engine down with it${via}`;
  (recovered ? state.engineStalled : state.enginePossiblyKilled).add(blame.testPath);
  console.log(redOrYellow(recovered)(`  ${client.laneTag} ⚠ ${blame.testPath} ${reason}`));
}

function redOrYellow(recovered) {
  return recovered ? yellow : red;
}

async function recoverLaneEngine(client, state, item) {
  const firstDetector = !isRecovering(client.engine);
  const blame = oldestTestOnEngine(state, client.engine) ?? item;
  const recovered = await recoverWorker(state, client.engine, recoveryLaneTag(client));
  if (firstDetector) reportEngineBlame(client, item, blame, recovered, state);
  if (!recovered && ENGINES.every((engine) => engine.dead)) state.aborted = true;
  return recovered;
}

function recoveryLaneTag(client) {
  return client.laneTag || "lane";
}

function recordPostTimeoutRecovery(state, item, startedAt, durationMs) {
  if (PROFILE && state.results[item.idx]) {
    state.results[item.idx].profile ??= { phases: {} };
    state.results[item.idx].profile.phases.postTimeoutRecoverMs =
      Date.now() - startedAt - durationMs;
  }
}

async function reconnectAfterTest(client, state, item, startedAt, durationMs) {
  const reconnectStartedAt = Date.now();
  try {
    await reconnectClient(client);
    if (CONCURRENCY === 1) {
      console.log(dim(`  ${client.laneTag} [reconnected in ${Date.now() - reconnectStartedAt}ms]`));
    }
    recordPostTimeoutRecovery(state, item, startedAt, durationMs);
    return true;
  } catch (err) {
    console.log(
      dim(
        `  ${client.laneTag} [reconnect failed in ${Date.now() - reconnectStartedAt}ms: ${err?.message || err}]`,
      ),
    );
    return false;
  }
}

async function handleLaneRecovery(client, state, item, result, startedAt, durationMs) {
  if (!recoverableResult(result)) return true;
  if (!(await probeKitesurf(client.engine, 2000))) {
    const recovered = await recoverLaneEngine(client, state, item);
    if (!recovered) return false;
  }
  return reconnectAfterTest(client, state, item, startedAt, durationMs);
}

async function runLaneTest(client, state, item) {
  const expEntry = state.expectations[item.testPath];
  const expected = expectedOutcome(expEntry);
  const perTestTimeout = timeoutOverride(expEntry);
  const isSlow = markedSlow(expEntry);
  const startedAt = Date.now();
  state.inFlight.set(client.laneTag, {
    testPath: item.testPath,
    idx: item.idx,
    startedAt,
    engine: client.engine,
  });
  let result;
  try {
    result = await executeLaneTestResult(client, item.testPath, expected, perTestTimeout, isSlow);
  } finally {
    state.inFlight.delete(client.laneTag);
  }
  const { ms, unexpected } = recordLaneResult(
    client,
    state,
    item,
    expected,
    isSlow,
    startedAt,
    result,
  );
  if (requestBail(state, unexpected)) return false;
  return handleLaneRecovery(client, state, item, result, startedAt, ms);
}

function expectedOutcome(entry) {
  return entry?.expected ?? "PASS";
}

function timeoutOverride(entry) {
  return entry?.timeout ?? null;
}

function markedSlow(entry) {
  return entry?.slow === true;
}

async function runLaneQueue(client, state) {
  while (true) {
    const item = nextTest(state);
    if (!item) break;
    if (!(await runLaneTest(client, state, item))) break;
  }
}

async function connectLane(client) {
  try {
    await connectClient(client);
    return true;
  } catch (err) {
    console.log(red(`  ${client.laneTag} lane failed to connect: ${err?.message || err}`));
    return false;
  }
}

async function runLane(laneId, state) {
  const client = createLane(laneId);
  if (!(await connectLane(client))) return;
  await runLaneQueue(client, state);
  await disconnectClient(client);
}

async function runAllLanes(state) {
  const lanes = [];
  for (let laneId = 0; laneId < CONCURRENCY; laneId++) lanes.push(runLane(laneId, state));
  await Promise.all(lanes);
}

function isRerunCandidate(result) {
  return result && result.unexpected && ["CRASH", "TIMEOUT", "ERROR"].includes(result.actual);
}

function rerunCandidates(results) {
  const candidates = [];
  for (let index = 0; index < results.length; index++) {
    if (isRerunCandidate(results[index])) candidates.push(index);
  }
  return candidates;
}

function shouldRerunCrashes(state) {
  return RERUN_CRASHES && !state.aborted && !state.bailRequested;
}

async function rerunCrashes(state) {
  if (!shouldRerunCrashes(state)) return;
  const candidates = rerunCandidates(state.results);
  if (candidates.length === 0) return;
  await runRerunPass(candidates, state);
}

function createRerunClient() {
  const engine = ENGINES.find((candidate) => !candidate.dead) ?? ENGINES[0];
  return createClient(engine, "");
}

async function prepareRerunClient(client, state) {
  if (!(await probeKitesurf(client.engine, 2000))) {
    const recovered = await recoverWorker(state, client.engine, "rerun");
    if (!recovered) {
      console.log(red(`[wpt-exec] rerun: worker did not recover — skipping rerun pass`));
    }
  }
  await connectClient(client);
}

async function recoverRerunEngine(client, state) {
  const recovered = await recoverWorker(state, client.engine, "rerun");
  if (!recovered) console.log(red(`[wpt-exec] rerun aborted — worker unrecoverable`));
  return recovered;
}

async function reconnectRerunClient(client) {
  try {
    await reconnectClient(client);
    return true;
  } catch (err) {
    console.log(
      red(`[wpt-exec] rerun: reconnect failed (${err?.message || err}) — aborting rerun pass`),
    );
    return false;
  }
}

async function ensureRerunEngine(client, state) {
  if (await probeKitesurf(client.engine, 2000)) return true;
  if (!(await recoverRerunEngine(client, state))) return false;
  return reconnectRerunClient(client);
}

async function runRerunTest(client, testPath, expected, perTestTimeout) {
  const startedAt = Date.now();
  let result;
  try {
    result = await runOne(
      client.page,
      testPath,
      expected,
      perTestTimeout,
      client.bridge,
      client.profSession,
    );
  } catch (err) {
    result = { actual: "CRASH", reason: `rerun threw: ${err?.message || err}`, subtests: [] };
  }
  return { result, ms: Date.now() - startedAt };
}

function removeOldUnexpected(state, old) {
  if (!old.unexpected) return;
  if (old.expected !== "PASS" && old.actual === "PASS") state.unexpectedPass--;
  else state.unexpectedFail--;
}

function stillBadResult(result) {
  return result.actual === "CRASH" || result.actual === "TIMEOUT" || result.actual === "ERROR";
}

function updateRerunCounts(state, old, result) {
  state.byOutcome[old.actual] = Math.max(0, (state.byOutcome[old.actual] ?? 0) - 1);
  state.byOutcome[result.actual] = (state.byOutcome[result.actual] ?? 0) + 1;
  removeOldUnexpected(state, old);
  const matched = result.actual === old.expected;
  const unexpected = updateUnexpectedCounts(state, old.expected, result, matched);
  return { matched, unexpected, stillBad: stillBadResult(result) };
}

function rerunVerdict(result, matched, stillBad) {
  return !matched
    ? stillBad
      ? red(`still ${result.actual}`)
      : red(`${result.actual}`)
    : result.actual === "PASS"
      ? green("→ PASS (was collateral)")
      : dim(`→ ${result.actual} (matched)`);
}

function logRerunResult(testPath, result, ms, matched, stillBad) {
  const verdict = rerunVerdict(result, matched, stillBad);
  const reason = result.reason ? ` — ${result.reason.slice(0, 60)}` : "";
  console.log(
    `  ${dim("[rerun]")} ${testPath.padEnd(60)} ${verdict} ${dim(`${ms}ms`)}${dim(reason)}`,
  );
}

function rerunResultRow(old, result, ms, unexpected) {
  return {
    test: old.test,
    expected: old.expected,
    actual: result.actual,
    reason: result.reason,
    subtests: result.subtests,
    counts: result.counts ?? null,
    harness: result.harness ?? null,
    durationMs: ms,
    unexpected,
    rerun: true,
    originalActual: old.actual,
    ...(result.profile ? { profile: result.profile } : {}),
  };
}

function recordRerunTotals(counters, matched, stillBad) {
  if (stillBad && !matched) counters.confirmed++;
  else counters.promoted++;
}

async function reconnectAfterRerun(client, result) {
  if (result.actual !== "CRASH" && result.actual !== "TIMEOUT") return;
  try {
    await reconnectClient(client);
  } catch {}
}

async function rerunOneCandidate(client, index, state, counters) {
  const old = state.results[index];
  const testPath = old.test;
  const entry = state.expectations[testPath];
  const perTestTimeout = entry?.timeout ?? null;
  if (!(await ensureRerunEngine(client, state))) return false;
  const { result, ms } = await runRerunTest(client, testPath, old.expected, perTestTimeout);
  const outcome = updateRerunCounts(state, old, result);
  recordRerunTotals(counters, outcome.matched, outcome.stillBad);
  logRerunResult(testPath, result, ms, outcome.matched, outcome.stillBad);
  state.results[index] = rerunResultRow(old, result, ms, outcome.unexpected);
  await reconnectAfterRerun(client, result);
  return true;
}

async function runRerunPass(candidates, state) {
  console.log("");
  console.log(
    dim(
      `[wpt-exec] rerunning ${candidates.length} CRASH/TIMEOUT/ERROR test(s) serially to filter collateral damage`,
    ),
  );
  const counters = { promoted: 0, confirmed: 0 };
  const client = createRerunClient();
  try {
    await prepareRerunClient(client, state);
    await runRerunCandidates(client, candidates, state, counters);
  } catch (err) {
    console.log(red(`[wpt-exec] rerun pass crashed: ${err?.message || err}`));
  } finally {
    await disconnectClient(client);
  }
  console.log(
    dim(
      `[wpt-exec] rerun complete: ${counters.promoted} promoted (collateral), ${counters.confirmed} confirmed`,
    ),
  );
}

async function runRerunCandidates(client, candidates, state, counters) {
  for (const index of candidates) {
    if (!(await rerunOneCandidate(client, index, state, counters))) break;
  }
}

function compactResultRows(state) {
  const denseResults = state.results.filter((result) => result != null);
  state.results.length = 0;
  state.results.push(...denseResults);
}

function annotateEngineOutcomes(state) {
  for (const row of state.results) {
    if (!row) continue;
    if (state.enginePossiblyKilled.has(row.test)) row.killedEngine = true;
    if (state.engineStalled.has(row.test)) row.stalledEngine = true;
  }
}

function summaryForResults(state) {
  const total = state.results.length;
  return {
    total,
    expected: total - state.unexpectedFail - state.unexpectedPass,
    unexpectedFail: state.unexpectedFail,
    unexpectedPass: state.unexpectedPass,
    byOutcome: state.byOutcome,
  };
}

function writeJsonOutput(state, summary) {
  if (!JSON_OUT) return;
  const outPath = resolve(JSON_OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        summary,
        truncated: state.truncated,
        requested: state.filtered.length,
        killedEngine: [...state.enginePossiblyKilled],
        stalledEngine: [...state.engineStalled],
        results: state.results,
      },
      null,
      2,
    ),
  );
}

function printReferenceCacheSummary() {
  if (refShotHits === 0) return;
  console.log(
    dim(
      `           ${refShotHits} reference screenshot(s) served from cache (${refShotCache.size} distinct refs rendered)`,
    ),
  );
}

function printKilledEngines(state) {
  if (state.enginePossiblyKilled.size === 0) return;
  console.log(red(`           ${state.enginePossiblyKilled.size} test(s) took the engine down:`));
  for (const test of state.enginePossiblyKilled) console.log(red(`             ${test}`));
}

function printStalledEngines(state) {
  if (state.engineStalled.size === 0) return;
  console.log(
    yellow(
      `           ${state.engineStalled.size} test(s) stalled the engine but it recovered (slow, not fatal):`,
    ),
  );
  for (const test of state.engineStalled) console.log(yellow(`             ${test}`));
}

function printPartialRunStatus(state, unrun) {
  if (state.truncated && MAX_TOTAL_MS > 0) {
    console.log(
      yellow(`           run truncated by --max-total ${MAX_TOTAL_MS}ms — partial results`),
    );
  }
  if (unrun > 0) {
    console.log(
      red(`           ${unrun} test(s) never ran (dead lanes) — PARTIAL RUN, exit non-zero`),
    );
  }
}

function printFinalSummary(state, summary, unrun) {
  console.log("");
  console.log(bold(`[wpt-exec] ${summary.expected}/${summary.total} matched expectations`));
  printReferenceCacheSummary();
  if (state.unexpectedFail > 0)
    console.log(red(`           ${state.unexpectedFail} regression(s)`));
  printKilledEngines(state);
  printStalledEngines(state);
  if (state.unexpectedPass > 0) {
    console.log(
      yellow(`           ${state.unexpectedPass} unexpected pass(es) — tighten expectations`),
    );
  }
  printPartialRunStatus(state, unrun);
}

function runExitCode(state) {
  return state.unexpectedFail === 0 && state.unexpectedPass === 0 && !state.truncated ? 0 : 1;
}

function finalizeRun(state) {
  compactResultRows(state);
  if (state.aborted) state.truncated = true;
  const total = state.results.length;
  const unrun = state.filtered.length - total;
  if (unrun > 0) state.truncated = true;
  const summary = summaryForResults(state);
  annotateEngineOutcomes(state);
  writeJsonOutput(state, summary);
  printFinalSummary(state, summary, unrun);
  process.exit(runExitCode(state));
}

async function main() {
  const { filtered, expectations } = loadRunInput();
  await verifyAllEngineHealth();
  const stallBudgetMs = stallBudgetFor(filtered, expectations);
  printRunConfiguration(filtered, stallBudgetMs);
  const state = createRunState(filtered, expectations, stallBudgetMs);
  await runAllLanes(state);
  await rerunCrashes(state);
  finalizeRun(state);
}
main().catch((err) => {
  console.error(red("[wpt-exec] fatal:"), err);
  process.exit(2);
});
