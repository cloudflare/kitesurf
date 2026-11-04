// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { localEngines } from "./local-engine.mjs";
import {
  coverageGaps,
  deviations as diffExpectations,
  loadAllowList,
  loadExpectations as readExpectations,
  rebaseline,
  reportGaps,
  reportResults,
  summarize,
} from "./pw-shared.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ENGINE_DIR = resolve(ROOT, "packages/engine");
const TESTS_JSON = resolve(ROOT, "tests/pw-tests.json");
const EXPECTATIONS_JSON = resolve(ROOT, "tests/pw-expectations.json");

const args = process.argv.slice(2);
const optionValue = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};
const PW_DIR = resolve(optionValue("--pw-dir") ?? resolve(ROOT, ".playwright"));
const OUT_DIR = resolve(optionValue("--out-dir") ?? join(PW_DIR, "test-results"));
const launcher = optionValue("--engine-launcher") ?? "wrangler";
const engineDist = resolve(optionValue("--dist") ?? resolve(ENGINE_DIR, ".wpt-dist"));
const resultsOut = optionValue("--results-out");
const noGate = args.includes("--no-gate");
if (launcher !== "wrangler" && launcher !== "miniflare") {
  console.error(`[pw-run] --engine-launcher wants wrangler or miniflare, got ${launcher}`);
  process.exit(2);
}
const updateExpectations = args.includes("--update-expectations");
const noRetry = args.includes("--no-retry");
const filterIdx = args.indexOf("--filter");
const filter = filterIdx >= 0 ? args[filterIdx + 1] : null;
const batchSizeIdx = args.indexOf("--batch-size");
const batchSize = batchSizeIdx >= 0 ? Math.max(1, parseInt(args[batchSizeIdx + 1], 10) || 1) : 1;
const grepIdx = args.indexOf("--grep");
const userGrep = grepIdx >= 0 ? args[grepIdx + 1] : null;
const specIdx = args.indexOf("--spec");
const spec = specIdx >= 0 ? args[specIdx + 1] : null;

if (!existsSync(join(PW_DIR, "packages/playwright/cli.js"))) {
  console.error("[pw-run] .playwright/ missing or unbuilt — run `pnpm run pw:setup` first");
  process.exit(1);
}

const allowList = loadAllowList(TESTS_JSON);
let specs = filter ? allowList.filter((e) => e.file.includes(filter)) : allowList;
if (spec) specs = specs.filter((e) => e.file === spec);
if (specs.length === 0) {
  console.error(
    spec
      ? `[pw-run] ${spec} is not an allow-listed spec${filter ? ` matching "${filter}"` : ""}`
      : `[pw-run] no allow-listed specs match filter "${filter}"`,
  );
  process.exit(1);
}

const { buildBundles, startEngine } = localEngines({
  tag: "pw-run",
  launcher,
  dist: engineDist,
  outDir: OUT_DIR,
  firstPort: 9720,
  skipBuildEnv: "PW_SKIP_BUILD",
});

function loadExpectations() {
  return readExpectations(EXPECTATIONS_JSON);
}

function skipGrepInvert() {
  const skips = Object.entries(loadExpectations())
    .filter(([, v]) => v.expected === "SKIP")
    .map(([id]) => idGrep(id));
  return skips.length ? `(?:${skips.join("|")})` : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactGrep(file, title) {
  return `${escapeRe(file)} ${escapeRe(title.replaceAll(" › ", " "))}$`;
}

function onlyGrep(entries) {
  const pats = entries.flatMap((e) => (e.only ?? []).map((t) => exactGrep(e.file, t)));
  return pats.length ? `(?:${pats.join("|")})` : null;
}

function idGrep(id) {
  const [file, ...rest] = id.split("::");
  return exactGrep(file, rest.join("::"));
}

function runPlaywright(wsEndpoint, specFiles, grep, tag) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonOut = join(OUT_DIR, `kitesurf-report-${tag}.json`);
  const blobOut = join(OUT_DIR, "blob", `${tag}.zip`);
  rmSync(jsonOut, { force: true });
  rmSync(blobOut, { force: true });
  const cliArgs = [
    "packages/playwright/cli.js",
    "test",
    "--config=tests/kitesurf/playwright.config.ts",
    ...specFiles,
  ];
  const invert = skipGrepInvert();
  if (invert) cliArgs.push("--grep-invert", invert);
  if (grep) cliArgs.push("--grep", grep);
  const r = spawnSync(process.execPath, cliArgs, {
    cwd: PW_DIR,
    stdio: "inherit",
    env: {
      ...process.env,
      NPM_TOKEN: process.env.NPM_TOKEN ?? "",
      PWPAGE_IMPL: "kitesurf",
      KITESURF_WS: wsEndpoint,
      PWTEST_JSON_OUTPUT: jsonOut,
      PLAYWRIGHT_BLOB_OUTPUT_FILE: blobOut,
    },
  });
  if (!existsSync(jsonOut)) {
    console.error(`[pw-run] batch ${tag}: no JSON report — runner crashed (exit ${r.status})`);
    return null;
  }
  return collectResults(jsonOut);
}

function collectResults(jsonPath) {
  return reportResults(JSON.parse(readFileSync(jsonPath, "utf8")));
}

function deviations(results) {
  return diffExpectations(results, loadExpectations());
}

async function runBatch(batchEntries, batchIdx, externalWs) {
  const label = `b${batchIdx}`;
  const batchFiles = batchEntries.map((e) => e.file);
  const only = onlyGrep(batchEntries);
  const grep = only && userGrep ? `(?=.*(?:${userGrep}))${only}` : (userGrep ?? only);
  let eng = null;
  let ws = externalWs;
  if (!externalWs) {
    eng = await startEngine();
    ws = eng.wsEndpoint;
  }
  console.log(
    `\n[pw-run] batch ${batchIdx}: ${batchFiles.length} file(s)${only ? " (only-selection)" : ""}${eng ? ` on :${eng.port}` : ""}`,
  );
  let results = runPlaywright(ws, batchFiles, grep, label) ?? {};
  eng?.stop();

  if (!noRetry) {
    const devs = deviations(results);
    if (devs.length > 0) {
      const grep = `(?:${devs.map((d) => idGrep(d.id)).join("|")})`;
      const files = [...new Set(devs.map((d) => d.id.split("::")[0]).map(fileToSpecArg))];
      console.log(
        `[pw-run] batch ${batchIdx}: retrying ${devs.length} deviation(s) on a fresh engine`,
      );
      let rEng = null;
      let rWs = externalWs;
      if (!externalWs) {
        rEng = await startEngine();
        rWs = rEng.wsEndpoint;
      }
      const retry = runPlaywright(rWs, files, grep, `${label}r`);
      rEng?.stop();
      if (retry) for (const [id, status] of Object.entries(retry)) results[id] = status;
    }
  }
  return results;
}

function fileToSpecArg(file) {
  return file.split("/").pop();
}

function compare(results) {
  const expectations = loadExpectations();
  const devs = deviations(results);
  if (updateExpectations) {
    writeFileSync(
      EXPECTATIONS_JSON,
      JSON.stringify(rebaseline(expectations, devs), null, 2) + "\n",
    );
    console.log(`[pw-run] rebaselined ${devs.length} expectation(s) → ${EXPECTATIONS_JSON}`);
    return 0;
  }
  console.log(`\n[pw-run] results: ${summarize(results)}`);
  const gaps = userGrep
    ? { emptyFiles: [], missingPins: [] }
    : coverageGaps(results, specs, expectations);
  if (reportGaps("pw-run", { devs, ...gaps })) {
    console.error(
      "[pw-run] if intentional: rerun with --update-expectations and commit the rebaseline separately",
    );
    return 1;
  }
  console.log("[pw-run] all results match expectations");
  return 0;
}

const externalWs = process.env.KITESURF_WS;
if (externalWs) {
  console.log(`[pw-run] attaching to external engine: ${externalWs} (no per-batch restart)`);
} else {
  await buildBundles();
}

const batches = [];
for (const e of specs) {
  const last = batches[batches.length - 1];
  if (e.only || !last || last.length >= batchSize || last.some((x) => x.only)) batches.push([e]);
  else last.push(e);
}
console.log(
  `[pw-run] ${specs.length} spec file(s) → ${batches.length} batch(es) of ${batchSize}${noRetry ? " (retry off)" : ""}`,
);

const merged = {};
const batchTimes = [];
for (let b = 0; b < batches.length; b++) {
  const started = Date.now();
  const res = await runBatch(batches[b], b, externalWs);
  for (const [id, status] of Object.entries(res)) merged[id] = status;
  batchTimes.push({ files: batches[b].map((entry) => entry.file), ms: Date.now() - started });
}
if (resultsOut) {
  writeFileSync(
    resultsOut,
    JSON.stringify(
      { files: specs.map((entry) => entry.file), results: merged, batches: batchTimes },
      null,
      1,
    ) + "\n",
  );
}
const verdict = compare(merged);
process.exit(noGate ? 0 : verdict);
