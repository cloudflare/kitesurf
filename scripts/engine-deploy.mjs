// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// `bazel run //packages/engine:deploy -- [--preview] <wrangler args>` (`pnpm run deploy`): uploads
// the Bazel-built engine to wrangler's account; --preview runs `wrangler versions upload` instead.
// :dist is already bundled, so wrangler uploads it unbundled beside a copy of the assets and a
// flattened copy of the public config.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SAME_ORIGIN_INSPECTOR = "/inspector/inspector.html";

function wranglerFrom(dir) {
  const req = createRequire(join(dir, "noop.js"));
  const pkg = req.resolve("wrangler/package.json");
  return {
    bin: resolve(dirname(pkg), JSON.parse(readFileSync(pkg, "utf8")).bin.wrangler),
    main: req.resolve("wrangler"),
  };
}

// Runfiles nest links into bazel-out, also to directories. Follow every one and write plain,
// writable files, so wrangler's state and any later chmod stay out of Bazel's outputs.
function copyTree(source, target) {
  if (!statSync(source).isDirectory()) {
    copyFileSync(source, target);
    chmodSync(target, 0o644);
    return;
  }
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) copyTree(join(source, name), join(target, name));
}

/**
 * Writes `out/worker` (bundle and wrangler.json) and `out/assets` from the built engine.
 * @param {string} engineDir @param {string} out
 * @returns {Promise<{wrangler: string, worker: string, inspector: string}>} */
export async function stageDeploy(engineDir, out) {
  const worker = join(out, "worker");
  const assets = join(out, "assets");
  copyTree(join(engineDir, "dist"), worker);
  copyTree(join(engineDir, "public"), assets);
  // Local-only files of the dry run: the miniflare options and the source map's build-time README.
  for (const name of ["engine-mf.json", "README.md"]) rmSync(join(worker, name), { force: true });

  const wrangler = wranglerFrom(engineDir);
  const { experimental_readRawConfig } = await import(pathToFileURL(wrangler.main).href);
  const { rawConfig } = experimental_readRawConfig({ config: join(engineDir, "wrangler.jsonc") });
  // The top-level config only: `env.local` is the dev server's, and `main` becomes the bundle.
  const flat = { ...rawConfig, main: "index.js", no_bundle: true, find_additional_modules: true };
  delete flat.$schema;
  delete flat.env;
  flat.assets = { ...rawConfig.assets, directory: "../assets" };
  // A --config=devtools build ships the frontend; point the inspector routes at it unless the
  // config names one. A `--var KITESURF_INSPECTOR_BASE_URL:<url>` argument still wins.
  const inspector = join(assets, "inspector");
  if (
    existsSync(inspector) &&
    readdirSync(inspector).length > 0 &&
    !flat.vars?.KITESURF_INSPECTOR_BASE_URL
  ) {
    flat.vars = { ...flat.vars, KITESURF_INSPECTOR_BASE_URL: SAME_ORIGIN_INSPECTOR };
  }
  writeFileSync(join(worker, "wrangler.json"), JSON.stringify(flat, null, 2) + "\n");
  return {
    wrangler: wrangler.bin,
    worker,
    inspector: flat.vars?.KITESURF_INSPECTOR_BASE_URL ?? "",
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runfiles = process.env.JS_BINARY__RUNFILES
    ? join(process.env.JS_BINARY__RUNFILES, "_main")
    : resolve(import.meta.dirname, "..");
  const out = mkdtempSync(join(tmpdir(), "kitesurf-deploy-"));
  try {
    const staged = await stageDeploy(join(runfiles, "packages/engine"), out);
    console.log(`[deploy] KITESURF_INSPECTOR_BASE_URL=${JSON.stringify(staged.inspector)}`);
    const preview = process.argv[2] === "--preview";
    const command = preview ? ["versions", "upload"] : ["deploy"];
    const rest = process.argv.slice(preview ? 3 : 2);
    const args = [staged.wrangler, ...command, "--config", "wrangler.json", ...rest];
    // `bazel run` sets BUILD_ID, which wrangler's CI detection reads as Jenkins. Wrangler would
    // then refuse to prompt, for example to pick one of several accounts.
    const { BUILD_ID: _invocation, ...env } = process.env;
    const r = spawnSync(process.execPath, args, { cwd: staged.worker, env, stdio: "inherit" });
    if (r.error) throw r.error;
    process.exitCode = r.status ?? 1;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
