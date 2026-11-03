#!/usr/bin/env node
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { execFileSync, execSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SELF_DIR, "..");
const PATCH_DIR = resolve(SELF_DIR, "patches");
const OUT_ROOT = resolve(REPO_ROOT, "packages/core/target/vendor-patched");

const CRATES = [
  { name: "parley", version: "0.12.0" },
  { name: "parley_engine", version: "0.12.0" },
  { name: "blitz-dom", version: "0.3.0-beta.4" },
  { name: "blitz-paint", version: "0.3.0-beta.4" },
  { name: "blitz-html", version: "0.3.0-beta.4" },
  { name: "anyrender", version: "0.14.0" },
  { name: "anyrender_vello_cpu", version: "0.18.0" },
  { name: "taffy", version: "0.15.0" },
  { name: "stylo_taffy", version: "0.3.0-beta.4" },
  { name: "stylo", version: "0.22.0" },
  { name: "selectors", version: "0.41.0" },
  { name: "boa_ast", version: "0.22.0" },
  { name: "boa_interner", version: "0.22.0" },
  { name: "boa_gc", version: "0.22.0" },
  { name: "boa_engine", version: "0.22.0" },
  { name: "boa_parser", version: "0.22.0" },
  { name: "usvg", version: "0.48.1" },
  { name: "vello_common", version: "0.3.0" },
  { name: "vello_cpu", version: "0.3.0" },
  { name: "ratatui-image", version: "8.1.1" },
  { name: "jpeg-encoder", version: "0.7.0" },
];

// Keep generated nested-repo commits independent of user/global Git configuration.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "kitesurf-vendor",
  GIT_AUTHOR_EMAIL: "vendor@kitesurf.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00 +0000",
  GIT_COMMITTER_NAME: "kitesurf-vendor",
  GIT_COMMITTER_EMAIL: "vendor@kitesurf.invalid",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00 +0000",
};

function log(msg) {
  process.stderr.write(`[vendor-patches] ${msg}\n`);
}

function git(args, cwd, { inherit = false } = {}) {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "inherit"],
  });
}

/** @returns {string} */
function findRegistrySource(crateName, version) {
  const cargoRoot = resolve(process.env.CARGO_HOME || resolve(homedir(), ".cargo"));
  const srcRoot = resolve(cargoRoot, "registry/src");
  const tryLookup = () => {
    if (!existsSync(srcRoot)) return null;
    const indexDirs = readdirSync(srcRoot).filter((s) => s.startsWith("index.crates.io-"));
    for (const indexDir of indexDirs) {
      const candidate = resolve(srcRoot, indexDir, `${crateName}-${version}`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  };
  const first = tryLookup();
  if (first) return first;
  // `cargo fetch` without the local patches can select newer compatible releases.
  // `info` downloads this exact registry source without resolving the workspace.
  log(`cargo registry source missing; downloading ${crateName}-${version}`);
  execFileSync(
    "cargo",
    ["info", "--locked", "--registry", "crates-io", `${crateName}@${version}`],
    {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "inherit"],
      timeout: 180_000,
    },
  );
  const second = tryLookup();
  if (second) return second;
  throw new Error(
    `${crateName}-${version} not present in cargo registry after cargo info. ` +
      `Check CARGO_HOME and the crates.io registry configuration.`,
  );
}

/** @returns {string[]} */
function listSeriesPatches(name, version) {
  const dir = resolve(PATCH_DIR, `${name}-${version}`);
  if (!existsSync(dir)) {
    throw new Error(`missing patch series dir: ${dir}`);
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".patch"))
    .sort()
    .map((f) => resolve(dir, f));
}

// Bump when base-tree materialization changes so existing series stamps no longer match.
const MATERIALISE_FORMAT = "2";

/** @returns {string} */
function seriesSha8(patchFiles) {
  const h = createHash("sha256");
  h.update(`format:${MATERIALISE_FORMAT}`);
  h.update("\0");
  for (const p of patchFiles) {
    h.update(basename(p));
    h.update("\0");
    h.update(readFileSync(p));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 8);
}

/** @returns {void} */
function materialiseInto(destDir, registrySrc, name, version, patchFiles) {
  // Materialized trees are disposable; durable edits must be committed and regenerated as patches.
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(dirname(destDir), { recursive: true });

  cpSync(registrySrc, destDir, { recursive: true });

  execSync(`chmod -R u+w "${destDir}"`);

  const vendorManifest = join(destDir, "Cargo.toml");
  const manifestSrc = readFileSync(vendorManifest, "utf8");
  if (!/^\[workspace\]/m.test(manifestSrc)) {
    // Isolate each nested crate from Cargo's root-workspace membership walk.
    writeFileSync(vendorManifest, manifestSrc + "\n[workspace]\n");
  }

  git(["init", "-q", "-b", "main"], destDir);

  // Exclude these markers so regen's dirty check sees only genuine crate edits.
  writeFileSync(join(destDir, ".git/info/exclude"), ".patched\n.patch-sha8\n");

  git(["add", "-A"], destDir);
  git(["commit", "-q", "-m", `pristine ${name}-${version} (crates.io registry source)`], destDir);
  git(["tag", "vendor-base"], destDir);

  if (patchFiles.length > 0) {
    git(["am", "--whitespace=nowarn", ...patchFiles], destDir, { inherit: true });
  }
}

function applyOne({ name, version }) {
  const patchFiles = listSeriesPatches(name, version);
  const outDir = resolve(OUT_ROOT, `${name}-${version}`);
  const marker = resolve(outDir, ".patched");
  const stampFile = resolve(outDir, ".patch-sha8");
  const expectedSha = seriesSha8(patchFiles);

  if (existsSync(marker) && existsSync(stampFile)) {
    try {
      const recordedSha = readFileSync(stampFile, "utf8").trim();
      if (recordedSha === expectedSha) return outDir;
    } catch {}
  }

  log(
    `materialising ${name}-${version} ` +
      `(${patchFiles.length} patch(es), series sha=${expectedSha})`,
  );
  const registrySrc = findRegistrySource(name, version);
  materialiseInto(outDir, registrySrc, name, version, patchFiles);

  writeFileSync(stampFile, expectedSha + "\n");
  writeFileSync(marker, new Date().toISOString() + "\n");

  return outDir;
}

/** @returns {Record<string, string>} */
function applyAll() {
  mkdirSync(OUT_ROOT, { recursive: true });
  const paths = {};
  for (const crate of CRATES) {
    paths[crate.name] = applyOne(crate);
  }
  return paths;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const paths = applyAll();
    for (const [name, path] of Object.entries(paths)) {
      process.stdout.write(`${name} ${path}\n`);
    }
  } catch (e) {
    log(`failed: ${e?.message ?? e}`);
    process.exit(1);
  }
}

export {
  applyAll as getPatchedVendorCrates,
  CRATES,
  GIT_ENV,
  findRegistrySource,
  listSeriesPatches,
  materialiseInto,
  seriesSha8,
};
