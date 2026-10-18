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

function parseArgs(arr) {
  const out = {};
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a === "--ws") (out.ws ??= []).push(arr[++i]);
    else if (a === "--base") out.base = arr[++i];
    else if (a === "--timeout") out.timeout = parseInt(arr[++i], 10);
    else if (a === "--bail") out.bail = true;
    else if (a === "--json-out") out.jsonOut = arr[++i];
    else if (a === "--skip-slow") out.skipSlow = true;
    else if (a === "--max-total") out.maxTotal = parseInt(arr[++i], 10);
    else if (a === "--concurrency" || a === "-j") out.concurrency = parseInt(arr[++i], 10);
    else if (a === "--recovery-budget") out.recoveryBudget = parseInt(arr[++i], 10);
    else if (a === "--stall-budget") out.stallBudget = parseInt(arr[++i], 10);
    else if (a === "--no-rerun-crashes") out.rerunCrashes = false;
    else if (a === "--skip-expected-timeouts") out.skipExpectedTimeouts = true;
    else if (a === "--skip-expected-crashes") out.skipExpectedCrashes = true;
    else if (a === "--force-run-file") out.forceRunFile = arr[++i];
    else if (a === "--expectations") out.expectations = arr[++i];
    else if (a === "--save-diff") out.saveDiff = arr[++i];
    else if (a === "--tests-file") out.testsFile = arr[++i];
    else if (a === "--help" || a === "-h") {
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
  if (harnessStatus !== "OK") {
    if (harnessStatus === "TIMEOUT") return "TIMEOUT";
    return "ERROR";
  }
  if (counts && Object.keys(counts).length > 0) {
    const statuses = Object.keys(counts);
    return statuses.length === 1 && statuses[0] === "PASS" ? "PASS" : "FAIL";
  }
  if (subtests.length === 0) {
    return "PASS";
  }
  return subtests.every((s) => s.status === "PASS") ? "PASS" : "FAIL";
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

function parseFuzzy(spec) {
  if (!spec) return { maxDiff: 0, maxPixels: 0 };
  spec = String(spec)
    .replace(/^[^[]*\[/, "")
    .replace(/\]$/, "")
    .trim();
  const fields = spec
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  let maxDiff = 0;
  let maxPixels = 0;
  for (const field of fields) {
    const eq = field.indexOf("=");
    let key, val;
    if (eq === -1) {
      if (maxDiff === 0 && fields.indexOf(field) === 0) {
        key = "maxDifference";
        val = field;
      } else {
        key = "totalPixels";
        val = field;
      }
    } else {
      key = field.slice(0, eq).trim();
      val = field.slice(eq + 1).trim();
    }
    // WPT fuzzy ranges use their upper bound as the accepted tolerance.
    const upper = (() => {
      const range = val.split("-");
      return parseInt(range[range.length - 1], 10) || 0;
    })();
    if (/^maxDifference$/i.test(key)) maxDiff = upper;
    else if (/^totalPixels$/i.test(key)) maxPixels = upper;
  }
  return { maxDiff, maxPixels };
}

async function captureScreenshotPng(page, _timeoutMs) {
  const buf = await page.screenshot({ type: "png", fullPage: false });
  return Buffer.from(buf);
}

// Raster quantization needs a one-level floor even when the WPT tolerance is zero.
const MAX_DIFF_FLOOR = 1;

function comparePngs(testPng, refPng, fuzzy, isMismatch) {
  if (testPng.equals(refPng)) {
    return {
      match: !isMismatch,
      diffPixels: 0,
      totalPixels: 0,
      reason: isMismatch ? "byte-equal but mismatch expected" : "byte-equal",
    };
  }
  let testImg, refImg;
  try {
    testImg = PNG.sync.read(testPng);
    refImg = PNG.sync.read(refPng);
  } catch (e) {
    return {
      match: false,
      diffPixels: -1,
      totalPixels: 0,
      reason: `png decode failed: ${e.message}`,
    };
  }
  if (testImg.width !== refImg.width || testImg.height !== refImg.height) {
    return {
      match: false,
      diffPixels: -1,
      totalPixels: 0,
      reason: `size mismatch: test=${testImg.width}x${testImg.height} ref=${refImg.width}x${refImg.height}`,
    };
  }
  const { width, height } = testImg;
  const totalPixels = width * height;
  const maxDiff = Math.max(fuzzy.maxDiff, MAX_DIFF_FLOOR);
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
  const matchPx = isMismatch ? diffPixels > 0 : diffPixels <= fuzzy.maxPixels;
  const floored = maxDiff !== fuzzy.maxDiff ? `, floor=${MAX_DIFF_FLOOR}` : "";
  const detail =
    `pixel-diff=${diffPixels}/${totalPixels} worstDelta=${worstDelta} ` +
    `fuzzy(maxDiff=${fuzzy.maxDiff}${floored}, maxPixels=${fuzzy.maxPixels})` +
    `${isMismatch ? " [mismatch]" : ""}`;
  return {
    match: matchPx,
    diffPixels,
    totalPixels,
    width,
    height,
    diffData,
    reason: matchPx ? `${detail} within tolerance` : `${detail} exceeds tolerance`,
  };
}

const refShotCache = new Map();
let refShotHits = 0;

async function runReftest(page, testInfo, timeoutMs, deadline, lap = () => {}) {
  const fuzzy = parseFuzzy(testInfo.fuzzy);
  const isMismatch = testInfo.rel === "mismatch";
  // Print and screen references differ, so media belongs in the reference-cache key.
  const cacheKey = `${testInfo.media ?? ""}\n${testInfo.href}`;

  if (testInfo.waiting) await waitForReftestReady(page, deadline);
  lap("refWaitMs");
  let testPng;
  try {
    testPng = await captureScreenshotPng(page, timeoutMs);
  } catch (e) {
    return { actual: "ERROR", reason: `test screenshot failed: ${e.message}`, subtests: [] };
  }
  lap("refShot1Ms");

  const renderRef = async () => {
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
  };
  let refPng;
  let refCached;
  try {
    ({ png: refPng, cached: refCached } = await getCachedRefScreenshot(
      refShotCache,
      cacheKey,
      renderRef,
    ));
    if (refCached) {
      refShotHits++;
      lap("refCacheWaitMs");
    }
  } catch (err) {
    if (err && typeof err === "object" && err.actual) return err;
    throw err;
  }

  const cmp = comparePngs(testPng, refPng, fuzzy, isMismatch);
  lap("refCompareMs");
  if (!cmp.match && argv.saveDiff && cmp.diffData) {
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

async function runCrashTest(page, testPath, deadline) {
  const probe = `(() => {
    const de = document.documentElement;
    return { waiting: !!de && de.classList.contains("test-wait"),
             path: location.pathname };
  })()`;
  const testUrlPath = new URL(`${WPT_BASE}${testPath}`).pathname;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await page.evaluate(probe);
    } catch (e) {
      return {
        actual: "CRASH",
        reason: `page unreachable: ${e.message}`,
        subtests: [],
        source: "crashtest",
      };
    }
    if (last && last.path === testUrlPath && !last.waiting) {
      return {
        actual: "PASS",
        reason: "crashtest: loaded without crashing",
        subtests: [],
        source: "crashtest",
      };
    }
    await sleep(CRASHTEST_POLL_INTERVAL_MS);
  }
  return {
    actual: "TIMEOUT",
    reason: last?.waiting
      ? "crashtest: test-wait never cleared"
      : "crashtest: navigate never settled",
    subtests: [],
    source: "crashtest",
  };
}

async function runOne(page, testPath, expected, perTestTimeoutMs, bridge, profSession) {
  if (expected === "SKIP") {
    return { actual: "SKIP", reason: "marked SKIP in expectations", subtests: [] };
  }
  const prof = PROFILE ? { phases: {}, scrapeIters: 0 } : null;
  let lapT = Date.now();
  const lap = (name) => {
    if (!prof) return;
    const now = Date.now();
    prof.phases[name] = (prof.phases[name] ?? 0) + (now - lapT);
    lapT = now;
  };
  const withProf = (r) => (prof ? { ...r, profile: prof } : r);
  if (expected === "TIMEOUT" && argv.skipExpectedTimeouts && !FORCE_RUN.has(testPath)) {
    return {
      actual: "TIMEOUT",
      reason: "expected TIMEOUT (--skip-expected-timeouts)",
      subtests: [],
      synthetic: true,
    };
  }
  if (expected === "CRASH" && argv.skipExpectedCrashes && !FORCE_RUN.has(testPath)) {
    return {
      actual: "CRASH",
      reason: "expected CRASH (--skip-expected-crashes)",
      subtests: [],
      synthetic: true,
    };
  }

  const url = `${WPT_BASE}${testPath}`;
  const timeoutMs = budgetFor({ timeout: perTestTimeoutMs, expected });

  const HARD_DEADLINE_MS = timeoutMs + TEST_HARD_DEADLINE_GRACE_MS;
  const t0 = Date.now();

  const wantsPrintMedia =
    /-print(?:-ref)?(?:\.tentative)?\.html$/.test(testPath) ||
    testPath.startsWith("/css/printing/");

  const isCrashTest =
    /-crash(?:\.[\w-]+)*\.x?html?$/.test(testPath) || testPath.includes("/crashtests/");

  const expectedUrl = new URL(url);
  const expectedUrlPath = expectedUrl.pathname;
  const expectedUrlLocation = expectedUrl.pathname + expectedUrl.search;
  let pageError = null;
  const onPageError = (error) => {
    try {
      const liveUrl = new URL(page.url());
      if (liveUrl.pathname + liveUrl.search !== expectedUrlLocation) return;
    } catch {
      return;
    }
    if (!pageError) pageError = String((error && error.stack) || error);
  };
  page.on("pageerror", onPageError);
  let outcome;
  try {
    outcome = await withDeadline("test", HARD_DEADLINE_MS, async () => {
      try {
        const session = await page.target().createCDPSession();
        // Apply print media before navigation so its rules affect the first render.
        await session.send("Emulation.setEmulatedMedia", {
          media: wantsPrintMedia ? "print" : "",
        });
        await session.detach();
      } catch {}
      lap("mediaMs");
      try {
        bridge?.reset();
      } catch {}
      await page.goto(url, { timeout: timeoutMs }).catch(() => {});
      lap("gotoMs");
      if (prof && profSession) {
        try {
          const r = await profSession.send("Kitesurf.getNavigatePhases", {});
          const byTarget = r?.byTarget ?? {};
          prof.engine = Object.values(byTarget).find((p) => p && typeof p === "object") ?? null;
        } catch {}
        lap("profOverheadMs");
      }

      if (isCrashTest) {
        const crashTestResult = await runCrashTest(page, testPath, t0 + timeoutMs);
        lap("crashPollMs");
        return { crashTestResult };
      }

      let reftest = null;
      try {
        reftest = await detectReftest(page);
      } catch {}
      lap("detectMs");
      if (reftest) {
        reftest.testPath = testPath;
        reftest.href = referenceUrlForVariant(reftest.href, testPath);
        reftest.media = wantsPrintMedia ? "print" : "";
        const reftestResult = await runReftest(page, reftest, timeoutMs, t0 + timeoutMs, lap);
        return { reftestResult };
      }

      const scrapeDeadline = t0 + timeoutMs;
      const testUrlPath = expectedUrlPath;
      while (Date.now() < scrapeDeadline) {
        let scraped = null;
        if (prof) prof.scrapeIters++;
        try {
          scraped = await page.evaluate(SCRAPER_SOURCE);
        } catch {}
        lap("scrapeEvalMs");
        if (scraped && scraped.value) {
          let livePath = null;
          try {
            livePath = await page.evaluate(`location.pathname`);
          } catch {}
          lap("pathCheckMs");
          // Reused pages may retain an old #log; reject readable pathname mismatches only.
          if (livePath && livePath !== testUrlPath) {
          } else {
            return { payload: scraped.value, source: scraped.source };
          }
        }
        try {
          await bridge?.drain();
        } catch {}
        lap("drainMs");
        await sleep(TESTHARNESS_SCRAPE_POLL_INTERVAL_MS);
        lap("scrapeSleepMs");
      }
      let errInfo = null;
      try {
        errInfo = await page.evaluate(`globalThis.__ks_wpt_error`);
      } catch {}
      return { payload: null, errInfo };
    });
  } finally {
    page.off("pageerror", onPageError);
  }

  if (outcome.kind === "deadline") {
    return withProf({
      actual: "TIMEOUT",
      reason: `hard deadline after ${HARD_DEADLINE_MS}ms (likely goto or evaluate hung)`,
      subtests: [],
    });
  }
  if (outcome.kind === "err") {
    return withProf({
      actual: "CRASH",
      reason: String((outcome.err && outcome.err.message) || outcome.err),
      subtests: [],
    });
  }

  if (outcome.value && outcome.value.reftestResult) {
    return withProf(outcome.value.reftestResult);
  }
  if (outcome.value && outcome.value.crashTestResult) {
    return withProf(outcome.value.crashTestResult);
  }

  const { payload, source, errInfo } = outcome.value;
  if (!payload) {
    const error = pageError || errInfo;
    return withProf({
      actual: error ? "ERROR" : "TIMEOUT",
      reason: error
        ? `no testharness results scraped (page error: ${error})`
        : `no testharness results scraped within ${timeoutMs}ms`,
      subtests: [],
    });
  }

  const harnessStatus = normalizeHarness(payload.harness.status);
  const subtests = payload.subtests.map((s) => ({
    name: s.name,
    status: normalizeSubtest(s.status),
    message: s.message,
  }));
  const counts = payload.counts ?? null;

  return withProf({
    actual: classifyResult(harnessStatus, subtests, counts),
    reason: null,
    source,
    harness: { status: harnessStatus, message: payload.harness.message },
    subtests,
    counts,
  });
}

async function main() {
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

  async function probeHealth(engine, timeoutMs = 2500) {
    try {
      const r = await fetch(engine.healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
      return r.ok ? "ok" : "stalled";
    } catch (err) {
      const code = err?.cause?.code ?? err?.code;
      if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENOTFOUND") {
        return "refused";
      }
      return "stalled";
    }
  }
  async function probeKitesurf(engine, timeoutMs = 2500) {
    return (await probeHealth(engine, timeoutMs)) === "ok";
  }
  async function retryReconnect(engine, once) {
    const ATTEMPTS = 4;
    const RECONNECT_HEALTH_WAIT_BUDGET_MS = 10_000;
    const RECONNECT_HEALTH_POLL_INTERVAL_MS = 500;
    const RECONNECT_RETRY_BASE_DELAY_MS = 250;
    const RECONNECT_RETRY_JITTER_MS = 500;
    let lastErr;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        return await once();
      } catch (err) {
        lastErr = err;
        if (attempt < ATTEMPTS) {
          const t0 = Date.now();
          while (
            Date.now() - t0 < RECONNECT_HEALTH_WAIT_BUDGET_MS &&
            !(await probeKitesurf(engine, 2000))
          ) {
            await sleep(RECONNECT_HEALTH_POLL_INTERVAL_MS);
          }
          await sleep(
            RECONNECT_RETRY_BASE_DELAY_MS * attempt + Math.random() * RECONNECT_RETRY_JITTER_MS,
          );
        }
      }
    }
    throw lastErr;
  }

  for (const engine of ENGINES) {
    if (!(await probeKitesurf(engine, 3000))) {
      console.error(red(`[wpt-exec] cannot reach kitesurf health at ${engine.healthUrl}`));
      console.error(red(`         start it with: pnpm run dev`));
      console.error(red(`         (or wait — workerd may be restarting after a crash)`));
      process.exit(2);
    }
  }

  const STALL_BUDGET_MS =
    argv.stallBudget ??
    filtered.reduce(
      (mx, t) => Math.max(mx, budgetFor(expectations[t]) + TEST_HARD_DEADLINE_GRACE_MS),
      0,
    ) + STALL_BUDGET_EXTRA_GRACE_MS;

  console.log(
    dim(
      ENGINES.length === 1
        ? `[wpt-exec] connecting to ${WS}`
        : `[wpt-exec] connecting to ${ENGINES.length} engines: ${ENGINES.map((e) => e.ws).join(", ")}`,
    ),
  );
  console.log(
    dim(
      `[wpt-exec] running ${filtered.length} test(s) (timeout ${TEST_TIMEOUT_MS}ms each, concurrency ${CONCURRENCY})`,
    ),
  );
  console.log(
    dim(
      `[wpt-exec] health budgets: ${RECOVERY_BUDGET_MS}ms if the port is refused, ${STALL_BUDGET_MS}ms if it is merely starved`,
    ),
  );
  if (SKIP_SLOW) console.log(dim(`[wpt-exec] --skip-slow: skipping tests marked slow`));
  if (MAX_TOTAL_MS > 0) console.log(dim(`[wpt-exec] --max-total: ${MAX_TOTAL_MS}ms hard ceiling`));
  console.log("");

  const results = new Array(filtered.length).fill(null);
  const inFlight = new Map();
  const enginePossiblyKilled = new Set();
  const engineStalled = new Set();
  let unexpectedFail = 0;
  let unexpectedPass = 0;
  const byOutcome = {};
  const runStart = Date.now();
  let truncated = false;
  let aborted = false;
  let bailRequested = false;

  let queueCursor = 0;
  function nextTest() {
    if (aborted || bailRequested) return null;
    if (MAX_TOTAL_MS > 0 && Date.now() - runStart >= MAX_TOTAL_MS) {
      if (!truncated) {
        truncated = true;
        console.log("");
        console.log(
          dim(
            `[wpt-exec] --max-total ${MAX_TOTAL_MS}ms reached; ${filtered.length - queueCursor} test(s) not run`,
          ),
        );
      }
      return null;
    }
    if (queueCursor >= filtered.length) return null;
    const idx = queueCursor++;
    return { idx, testPath: filtered[idx] };
  }

  const isRecovering = (engine) => engine.recoveryInFlight !== null;
  const engineTag = (engine) => (ENGINES.length > 1 ? `engine ${engine.index} ` : "");
  async function recoverWorker(engine, triggerLaneTag) {
    if (engine.recoveryInFlight) return engine.recoveryInFlight;
    engine.recoveryInFlight = (async () => {
      console.log("");
      console.log(
        yellow(
          `[wpt-exec] ${triggerLaneTag}: kitesurf ${engineTag(engine)}health probe failed; waiting for recovery...`,
        ),
      );
      const t0 = Date.now();
      let budget = RECOVERY_BUDGET_MS;
      let sawStall = false;
      while (Date.now() - t0 < budget) {
        const state = await probeHealth(engine, 2000);
        if (state === "ok") {
          const took = Date.now() - t0;
          const how = sawStall ? " (was starved, never dead)" : "";
          console.log(
            green(
              `[wpt-exec] kitesurf ${engineTag(engine)}recovered after ${took}ms${how} — resuming`,
            ),
          );
          return true;
        }
        // A probe timeout is not proof of death; give stalled responses the longer budget.
        if (state === "stalled" && !sawStall) {
          sawStall = true;
          budget = STALL_BUDGET_MS;
          console.log(
            yellow(
              `[wpt-exec] /health accepted the socket but did not answer — ${engineTag(engine)}is starved, not dead; extending to ${Math.round(budget / 1000)}s`,
            ),
          );
        }
        await sleep(ENGINE_RECOVERY_POLL_INTERVAL_MS);
      }
      engine.dead = true;
      const alive = ENGINES.filter((e) => !e.dead).length;
      console.log(
        red(
          `[wpt-exec] kitesurf ${engineTag(engine)}did not recover within ${Math.round(budget / 1000)}s — ` +
            (alive > 0 ? `dropping its lane(s); ${alive} engine(s) still up` : `aborting batch`),
        ),
      );
      return false;
    })();
    const ok = await engine.recoveryInFlight;
    engine.recoveryInFlight = null;
    return ok;
  }

  function formatResultLine(laneTag, testPath, ms, r, expected, matched, skippedAsSlow) {
    const tag = laneTag ? `${dim(laneTag)} ` : "";
    const path = testPath.padEnd(60);
    if (!matched) {
      if (expected !== "PASS" && r.actual === "PASS") {
        return `  ${tag}${path} ${yellow("?PASS")} ${dim(`${ms}ms`)}  ${dim(`expected ${expected}, got PASS`)}`;
      }
      const reason = r.reason ? ` — ${r.reason.slice(0, 60)}` : "";
      return `  ${tag}${path} ${red("✗")} ${dim(`${ms}ms`)}  ${red(r.actual)} ${dim(`(expected ${expected})${reason}`)}`;
    }
    if (skippedAsSlow) {
      return `  ${tag}${path} ${dim("⤵")} ${dim(`${ms}ms`)}  ${dim("SKIP (slow)")}`;
    }
    const okTag = r.actual === "PASS" ? green("✓") : dim("·");
    const detail = r.counts ? dim(` (${formatCounts(r.counts)})`) : "";
    return `  ${tag}${path} ${okTag} ${dim(`${ms}ms`)}  ${dim(r.actual)}${detail}`;
  }

  async function runLane(laneId) {
    const laneTag = CONCURRENCY > 1 ? `[w${laneId}]` : "";
    const engine = ENGINES[laneId % ENGINES.length];
    let browser, page, bridge, profSession;

    async function installBridge() {
      bridge = null;
      profSession = null;
      try {
        const session = await page.createCDPSession();
        bridge = createTestdriverBridge({ page, session });
        await attachTestdriverBinding(session, bridge);
        if (PROFILE) profSession = session;
      } catch {}
    }

    async function connect() {
      browser = await puppeteer.connect({ browserWSEndpoint: engine.ws });
      page = await browser.newPage();
      try {
        await page.evaluateOnNewDocument(HOOK_SOURCE);
      } catch {}
      await installBridge();
    }

    async function reconnect() {
      return retryReconnect(engine, reconnectOnce);
    }

    async function reconnectOnce() {
      try {
        await browser?.disconnect();
      } catch {}
      const RECONNECT_BUDGET_MS = 5000;
      const t0 = Date.now();
      const remaining = () => Math.max(0, RECONNECT_BUDGET_MS - (Date.now() - t0));
      const withTimeout = (p, label) =>
        Promise.race([
          p,
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error(`reconnect ${label} timed out`)), remaining()),
          ),
        ]);
      browser = await withTimeout(puppeteer.connect({ browserWSEndpoint: engine.ws }), "connect");
      page = await withTimeout(browser.newPage(), "newPage");
      try {
        await withTimeout(page.evaluateOnNewDocument(HOOK_SOURCE), "hook-install");
      } catch {}
      await installBridge();
    }

    try {
      await connect();
    } catch (err) {
      console.log(red(`  ${laneTag} lane failed to connect: ${err?.message || err}`));
      return;
    }

    while (true) {
      const item = nextTest();
      if (!item) break;
      const { idx, testPath } = item;

      const expEntry = expectations[testPath];
      const expected = expEntry?.expected ?? "PASS";
      const perTestTimeout = expEntry?.timeout ?? null;
      const isSlow = expEntry?.slow === true;

      const t0 = Date.now();
      inFlight.set(laneTag, { testPath, idx, startedAt: t0, engine });
      let r;
      try {
        r =
          SKIP_SLOW && isSlow
            ? { actual: "SKIP", reason: "slow (--skip-slow)", subtests: [] }
            : await runOne(page, testPath, expected, perTestTimeout, bridge, profSession);
      } finally {
        inFlight.delete(laneTag);
      }
      const ms = Date.now() - t0;

      byOutcome[r.actual] = (byOutcome[r.actual] ?? 0) + 1;
      const skippedAsSlow = SKIP_SLOW && isSlow && r.actual === "SKIP";
      const matched = r.actual === expected || skippedAsSlow;
      let unexpected = false;
      if (!matched) {
        if (expected !== "PASS" && r.actual === "PASS") {
          unexpectedPass++;
          unexpected = true;
        } else {
          unexpectedFail++;
          unexpected = true;
        }
      }

      console.log(formatResultLine(laneTag, testPath, ms, r, expected, matched, skippedAsSlow));

      results[idx] = {
        test: testPath,
        expected,
        actual: r.actual,
        reason: r.reason,
        subtests: r.subtests,
        counts: r.counts ?? null,
        harness: r.harness ?? null,
        durationMs: ms,
        unexpected,
        ...(r.profile ? { profile: r.profile } : {}),
      };

      if (argv.bail && unexpected) {
        bailRequested = true;
        break;
      }

      if ((r.actual === "TIMEOUT" || r.actual === "CRASH") && !r.synthetic) {
        const alive = await probeKitesurf(engine, 2000);
        if (!alive) {
          const iAmFirstDetector = !isRecovering(engine);
          // The lane that notices may be a bystander; blame the oldest test still in flight.
          const culprit = [...inFlight.values()]
            .filter((v) => v.engine === engine)
            .sort((a, b) => a.startedAt - b.startedAt)[0];
          const blame = culprit ?? { testPath, idx };
          const recovered = await recoverWorker(engine, laneTag || "lane");
          if (iAmFirstDetector) {
            const via = blame.testPath === testPath ? "" : ` (noticed by ${testPath})`;
            const reason = recovered
              ? `starved the engine past the 2s health probe${via} — recovered, not a killer`
              : `took the engine down with it${via}`;
            (recovered ? engineStalled : enginePossiblyKilled).add(blame.testPath);
            console.log((recovered ? yellow : red)(`  ${laneTag} ⚠ ${blame.testPath} ${reason}`));
          }
          if (!recovered && ENGINES.every((e) => e.dead)) aborted = true;
          if (!recovered) break;
        }
        const rt0 = Date.now();
        try {
          await reconnect();
          if (CONCURRENCY === 1) {
            console.log(dim(`  ${laneTag} [reconnected in ${Date.now() - rt0}ms]`));
          }
          if (PROFILE && results[idx]) {
            results[idx].profile ??= { phases: {} };
            results[idx].profile.phases.postTimeoutRecoverMs = Date.now() - t0 - ms;
          }
        } catch (err) {
          console.log(
            dim(`  ${laneTag} [reconnect failed in ${Date.now() - rt0}ms: ${err?.message || err}]`),
          );
          break;
        }
      }
    }

    try {
      await browser?.disconnect();
    } catch {}
  }

  const lanes = [];
  for (let i = 0; i < CONCURRENCY; i++) lanes.push(runLane(i));
  await Promise.all(lanes);

  if (RERUN_CRASHES && !aborted && !bailRequested) {
    const candidates = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r) continue;
      if (!r.unexpected) continue;
      if (r.actual === "CRASH" || r.actual === "TIMEOUT" || r.actual === "ERROR") {
        candidates.push(i);
      }
    }

    if (candidates.length > 0) {
      const rerunPass = async () => {
        console.log("");
        console.log(
          dim(
            `[wpt-exec] rerunning ${candidates.length} CRASH/TIMEOUT/ERROR test(s) serially to filter collateral damage`,
          ),
        );

        let promoted = 0;
        let confirmed = 0;
        let browser, page, bridge, profSession;
        const engine = ENGINES.find((e) => !e.dead) ?? ENGINES[0];

        async function rerunInstallBridge() {
          bridge = null;
          profSession = null;
          try {
            const session = await page.createCDPSession();
            bridge = createTestdriverBridge({ page, session });
            await attachTestdriverBinding(session, bridge);
            if (PROFILE) profSession = session;
          } catch {}
        }

        async function rerunConnect() {
          browser = await puppeteer.connect({ browserWSEndpoint: engine.ws });
          page = await browser.newPage();
          try {
            await page.evaluateOnNewDocument(HOOK_SOURCE);
          } catch {}
          await rerunInstallBridge();
        }

        async function rerunReconnect() {
          return retryReconnect(engine, rerunReconnectOnce);
        }

        async function rerunReconnectOnce() {
          try {
            await browser?.disconnect();
          } catch {}
          const RECONNECT_BUDGET_MS = 5000;
          const t0 = Date.now();
          const remaining = () => Math.max(0, RECONNECT_BUDGET_MS - (Date.now() - t0));
          const withTimeout = (p, label) =>
            Promise.race([
              p,
              new Promise((_, rej) =>
                setTimeout(() => rej(new Error(`reconnect ${label} timed out`)), remaining()),
              ),
            ]);
          browser = await withTimeout(
            puppeteer.connect({ browserWSEndpoint: engine.ws }),
            "connect",
          );
          page = await withTimeout(browser.newPage(), "newPage");
          try {
            await withTimeout(page.evaluateOnNewDocument(HOOK_SOURCE), "hook-install");
          } catch {}
          await rerunInstallBridge();
        }

        try {
          if (!(await probeKitesurf(engine, 2000))) {
            const ok = await recoverWorker(engine, "rerun");
            if (!ok) {
              console.log(red(`[wpt-exec] rerun: worker did not recover — skipping rerun pass`));
            }
          }
          await rerunConnect();

          for (const idx of candidates) {
            const old = results[idx];
            const testPath = old.test;
            const expected = old.expected;
            const expEntry = expectations[testPath];
            const perTestTimeout = expEntry?.timeout ?? null;

            if (!(await probeKitesurf(engine, 2000))) {
              const ok = await recoverWorker(engine, "rerun");
              if (!ok) {
                console.log(red(`[wpt-exec] rerun aborted — worker unrecoverable`));
                break;
              }
              try {
                await rerunReconnect();
              } catch (err) {
                console.log(
                  red(
                    `[wpt-exec] rerun: reconnect failed (${err?.message || err}) — aborting rerun pass`,
                  ),
                );
                break;
              }
            }

            const t0 = Date.now();
            let r;
            try {
              r = await runOne(page, testPath, expected, perTestTimeout, bridge, profSession);
            } catch (err) {
              r = { actual: "CRASH", reason: `rerun threw: ${err?.message || err}`, subtests: [] };
            }
            const ms = Date.now() - t0;

            byOutcome[old.actual] = Math.max(0, (byOutcome[old.actual] ?? 0) - 1);
            byOutcome[r.actual] = (byOutcome[r.actual] ?? 0) + 1;
            if (old.unexpected) {
              if (old.expected !== "PASS" && old.actual === "PASS") unexpectedPass--;
              else unexpectedFail--;
            }
            const matched = r.actual === expected;
            let unexpected = false;
            if (!matched) {
              if (expected !== "PASS" && r.actual === "PASS") {
                unexpectedPass++;
                unexpected = true;
              } else {
                unexpectedFail++;
                unexpected = true;
              }
            }

            const stillBad = r.actual === "CRASH" || r.actual === "TIMEOUT" || r.actual === "ERROR";
            if (stillBad && !matched) confirmed++;
            else promoted++;

            const verdict = !matched
              ? stillBad
                ? red(`still ${r.actual}`)
                : red(`${r.actual}`)
              : r.actual === "PASS"
                ? green("→ PASS (was collateral)")
                : dim(`→ ${r.actual} (matched)`);
            const reason = r.reason ? ` — ${r.reason.slice(0, 60)}` : "";
            console.log(
              `  ${dim("[rerun]")} ${testPath.padEnd(60)} ${verdict} ${dim(`${ms}ms`)}${dim(reason)}`,
            );

            results[idx] = {
              test: testPath,
              expected,
              actual: r.actual,
              reason: r.reason,
              subtests: r.subtests,
              counts: r.counts ?? null,
              harness: r.harness ?? null,
              durationMs: ms,
              unexpected,
              rerun: true,
              originalActual: old.actual,
              ...(r.profile ? { profile: r.profile } : {}),
            };

            if (r.actual === "CRASH" || r.actual === "TIMEOUT") {
              try {
                await rerunReconnect();
              } catch {}
            }
          }
        } catch (err) {
          console.log(red(`[wpt-exec] rerun pass crashed: ${err?.message || err}`));
        } finally {
          try {
            await browser?.disconnect();
          } catch {}
        }

        console.log(
          dim(
            `[wpt-exec] rerun complete: ${promoted} promoted (collateral), ${confirmed} confirmed`,
          ),
        );
      };
      await rerunPass();
    }
  }

  const denseResults = results.filter((r) => r != null);
  results.length = 0;
  results.push(...denseResults);

  if (aborted) truncated = true;

  const total = results.length;
  const unrun = filtered.length - total;
  if (unrun > 0) truncated = true;
  const expectedCount = total - unexpectedFail - unexpectedPass;
  const summary = {
    total,
    expected: expectedCount,
    unexpectedFail,
    unexpectedPass,
    byOutcome,
  };

  for (const row of results) {
    if (!row) continue;
    if (enginePossiblyKilled.has(row.test)) row.killedEngine = true;
    if (engineStalled.has(row.test)) row.stalledEngine = true;
  }

  if (JSON_OUT) {
    const outPath = resolve(JSON_OUT);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          summary,
          truncated,
          requested: filtered.length,
          killedEngine: [...enginePossiblyKilled],
          stalledEngine: [...engineStalled],
          results,
        },
        null,
        2,
      ),
    );
  }

  console.log("");
  console.log(bold(`[wpt-exec] ${expectedCount}/${total} matched expectations`));
  if (refShotHits > 0) {
    console.log(
      dim(
        `           ${refShotHits} reference screenshot(s) served from cache (${refShotCache.size} distinct refs rendered)`,
      ),
    );
  }
  if (unexpectedFail > 0) console.log(red(`           ${unexpectedFail} regression(s)`));
  if (enginePossiblyKilled.size > 0) {
    console.log(red(`           ${enginePossiblyKilled.size} test(s) took the engine down:`));
    for (const t of enginePossiblyKilled) console.log(red(`             ${t}`));
  }
  if (engineStalled.size > 0) {
    console.log(
      yellow(
        `           ${engineStalled.size} test(s) stalled the engine but it recovered (slow, not fatal):`,
      ),
    );
    for (const t of engineStalled) console.log(yellow(`             ${t}`));
  }
  if (unexpectedPass > 0)
    console.log(yellow(`           ${unexpectedPass} unexpected pass(es) — tighten expectations`));
  if (truncated && MAX_TOTAL_MS > 0)
    console.log(
      yellow(`           run truncated by --max-total ${MAX_TOTAL_MS}ms — partial results`),
    );
  if (unrun > 0)
    console.log(
      red(`           ${unrun} test(s) never ran (dead lanes) — PARTIAL RUN, exit non-zero`),
    );

  process.exit(unexpectedFail === 0 && unexpectedPass === 0 && !truncated ? 0 : 1);
}

main().catch((err) => {
  console.error(red("[wpt-exec] fatal:"), err);
  process.exit(2);
});
