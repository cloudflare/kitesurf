// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REPORT_DIR, WPT_ROOT } from "./wpt-shared.mjs";

export const INVENTORY_FILE = resolve(REPORT_DIR, "inventory.json");

export const INVENTORY_TYPES = ["testharness", "reftest", "print-reftest", "crashtest"];

const MANIFEST_VERSION = 9;

/**
 * @param {{version: number, url_base?: string, items: Record<string, unknown>}} manifest
 * @returns {{types: Record<string, number>, tests: string[]}}
 */
export function inventoryFromManifest(manifest, types = INVENTORY_TYPES) {
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(
      `unsupported MANIFEST.json version ${manifest.version} (want ${MANIFEST_VERSION})`,
    );
  }
  const urlBase = manifest.url_base ?? "/";
  const urls = new Set();
  /** @type {Record<string, number>} */
  const counts = {};
  for (const type of types) {
    let count = 0;
    /** @param {unknown} node @param {string} path */
    const walk = (node, path) => {
      if (node == null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        // Manifest v9 trie leaves start with a hash; later entries carry URLs and metadata.
        for (const item of node.slice(1)) {
          const url = Array.isArray(item) && typeof item[0] === "string" ? item[0] : path;
          urls.add(urlBase + url);
          count++;
        }
        return;
      }
      for (const [name, child] of Object.entries(node))
        walk(child, path ? `${path}/${name}` : name);
    };
    walk(manifest.items[type], "");
    counts[type] = count;
  }
  return { types: counts, tests: [...urls].sort() };
}

function summaryCounts(summary, test) {
  if (!Object.hasOwn(summary, test)) return undefined;
  return summary[test]?.c;
}

function subtestCount(counts) {
  if (!Array.isArray(counts) || typeof counts[1] !== "number") return undefined;
  return Math.max(1, counts[1]);
}

/** @param {Record<string, {c?: unknown}>} summary
 * @param {string[]} tests
 * @returns {Record<string, number>} */
export function referenceSubtests(summary, tests) {
  /** @type {Record<string, number>} */
  const subtests = {};
  for (const test of tests) {
    const count = subtestCount(summaryCounts(summary, test));
    // wpt.fyi reports a test without subtests as [0, 0] whatever its status.
    if (count !== undefined) subtests[test] = count;
  }
  return subtests;
}

const WPT_FYI_RUNS = "https://wpt.fyi/api/runs";

/** @typedef {{
 * id: number, browser_name: string, browser_version: string,
 * results_url: string
 * }} WptRun */

/** @typedef {{
 * runId: number, browser: string, version: string,
 * subtests: Record<string, number>
 * }} WptReference */

/** @param {string} revision
 * @param {string[]} tests
 * @param {typeof fetch} [fetchImpl=fetch]
 * @returns {Promise<WptReference | null>} */
export async function fetchReference(revision, tests, fetchImpl = fetch) {
  const query = new URLSearchParams({ product: "chrome", sha: revision, label: "master" });
  const runsResponse = await fetchImpl(`${WPT_FYI_RUNS}?${query}`);
  if (!runsResponse.ok) throw new Error(`wpt.fyi runs: HTTP ${runsResponse.status}`);
  const [run] = /** @type {WptRun[]} */ (await runsResponse.json());
  if (!run) return null;
  const summaryResponse = await fetchImpl(run.results_url);
  if (!summaryResponse.ok) throw new Error(`wpt.fyi summary: HTTP ${summaryResponse.status}`);
  return {
    runId: run.id,
    browser: run.browser_name,
    version: run.browser_version,
    subtests: referenceSubtests(await summaryResponse.json(), tests),
  };
}

function parseArgs(argv) {
  const opts = {
    out: INVENTORY_FILE,
    manifest: null,
    reference: true,
    wptDir: process.env.KITESURF_WPT_DIR ? resolve(process.env.KITESURF_WPT_DIR) : WPT_ROOT,
    pin: null,
    addReference: null,
    pythonPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") opts.out = resolve(argv[++i]);
    else if (argv[i] === "--manifest") opts.manifest = resolve(argv[++i]);
    else if (argv[i] === "--no-reference") opts.reference = false;
    else if (argv[i] === "--wpt-dir") opts.wptDir = resolve(argv[++i]);
    else if (argv[i] === "--revision-file")
      opts.pin = JSON.parse(readFileSync(resolve(argv[++i]), "utf8")).revision;
    else if (argv[i] === "--add-reference") opts.addReference = resolve(argv[++i]);
    else if (argv[i] === "--pythonpath") opts.pythonPath = resolve(argv[++i]);
    else throw new Error(`unknown option: ${argv[i]}`);
  }
  return opts;
}

function buildManifest(path, options, scratch) {
  const args = [
    "wpt",
    "--venv",
    join(scratch, "venv"),
    "--skip-venv-setup",
    "manifest",
    "--no-download",
    "-p",
    path,
    "--tests-root",
    options.wptDir,
    "--cache-root",
    join(scratch, "cache"),
  ];
  const env = { ...process.env };
  if (options.pythonPath)
    env.PYTHONPATH = [options.pythonPath, env.PYTHONPATH].filter(Boolean).join(":");
  const run = spawnSync("python3", args, {
    cwd: options.wptDir,
    stdio: "inherit",
    env,
  });
  if (run.status !== 0) throw new Error(`wpt manifest failed (code ${run.status})`);
}

function wptRevision(wptDir) {
  const marker = resolve(wptDir, ".revision");
  if (existsSync(marker)) return readFileSync(marker, "utf8").trim();
  const run = spawnSync("git", ["rev-parse", "HEAD"], { cwd: wptDir, encoding: "utf8" });
  return run.status === 0 ? run.stdout.trim() : null;
}

/** @param {string | null} revision @param {string[]} tests */
async function tryFetchReference(revision, tests) {
  if (!revision) {
    console.warn("[wpt-inventory] WARN: no .wpt revision, so no reference subtest counts");
    return undefined;
  }
  try {
    const reference = await fetchReference(revision, tests);
    if (reference) {
      const known = Object.keys(reference.subtests).length;
      console.log(
        `[wpt-inventory] ${reference.browser} ${reference.version} (wpt.fyi run ${reference.runId}) counts subtests for ${known} of ${tests.length} tests`,
      );
      return reference;
    }
    console.warn(`[wpt-inventory] WARN: wpt.fyi has no Chrome run at ${revision}`);
  } catch (error) {
    console.warn(`[wpt-inventory] WARN: no reference subtest counts: ${error}`);
  }
  return undefined;
}

async function addReference(path) {
  const inventory = JSON.parse(readFileSync(path, "utf8"));
  inventory.reference = await tryFetchReference(inventory.revision, inventory.tests);
  writeFileSync(path, JSON.stringify(inventory));
}

function checkRevision(pin, revision, wptDir) {
  if (pin && revision !== pin) {
    throw new Error(`WPT corpus at ${wptDir} is ${revision ?? "unknown"}, expected ${pin}`);
  }
}

function prepareManifest(opts) {
  let manifestPath = opts.manifest;
  let scratch = null;
  if (!manifestPath) {
    scratch = mkdtempSync(join(tmpdir(), "wpt-inventory-"));
    manifestPath = join(scratch, "MANIFEST.json");
    buildManifest(manifestPath, opts, scratch);
  }
  return { manifestPath, scratch };
}

async function writeInventory(opts, revision, manifestPath) {
  const { types, tests } = inventoryFromManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  const reference = opts.reference ? await tryFetchReference(revision, tests) : undefined;
  mkdirSync(dirname(opts.out), { recursive: true });
  writeFileSync(opts.out, JSON.stringify({ revision, types, tests, reference }));
  console.log(
    `[wpt-inventory] wrote ${tests.length} tests to ${opts.out} ${JSON.stringify(types)}`,
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.addReference) {
    await addReference(opts.addReference);
    return;
  }
  const revision = wptRevision(opts.wptDir);
  checkRevision(opts.pin, revision, opts.wptDir);
  const { manifestPath, scratch } = prepareManifest(opts);
  try {
    await writeInventory(opts, revision, manifestPath);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
