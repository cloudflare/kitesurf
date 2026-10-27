#!/usr/bin/env node
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CRATES,
  GIT_ENV,
  findRegistrySource,
  listSeriesPatches,
  materialiseInto,
  seriesSha8,
} from "./get-patched-vendor-crates.mjs";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SELF_DIR, "..");
const PATCH_DIR = resolve(SELF_DIR, "patches");
const PATCHED_ROOT = resolve(REPO_ROOT, "packages/core/target/vendor-patched");

function log(msg) {
  process.stderr.write(`[regen-patches] ${msg}\n`);
}

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function normalizePatchWhitespace(content) {
  if (content.endsWith(" \n")) {
    const hunks = [...content.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/gm)];
    const hunk = hunks.at(-1);
    if (!hunk) throw new Error("patch ends in context but contains no hunk header");

    const count = (value) => {
      const decremented = Number(value ?? 1) - 1;
      return decremented === 1 ? "" : `,${decremented}`;
    };
    const header = hunk[0].replace(
      /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)?/,
      `@@ -${hunk[1]}${count(hunk[2])} +${hunk[3]}${count(hunk[4])}`,
    );
    content =
      content.slice(0, hunk.index) + header + content.slice(hunk.index + hunk[0].length, -2);
  }
  return content.replace(/^ $/gm, "");
}

function regenOne({ name, version }) {
  const seriesDir = resolve(PATCH_DIR, `${name}-${version}`);
  const patchedDir = resolve(PATCHED_ROOT, `${name}-${version}`);
  if (!existsSync(join(patchedDir, ".git"))) {
    throw new Error(
      `no materialised git repo for ${name}-${version} at ${patchedDir}\n` +
        `  Run \`pnpm run vendor:apply\` first.`,
    );
  }

  try {
    git(["rev-parse", "-q", "--verify", "vendor-base^{commit}"], patchedDir);
  } catch {
    throw new Error(
      `${name}-${version}: no \`vendor-base\` tag in ${patchedDir}. ` +
        `Re-materialise with \`pnpm run vendor:apply\` after saving your edits.`,
    );
  }

  const dirty = git(["status", "--porcelain"], patchedDir).trim();
  if (dirty) {
    throw new Error(
      `${name}-${version}: uncommitted changes in ${patchedDir}:\n` +
        dirty
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n") +
        `\n  Commit them first (each commit becomes one patch):\n` +
        `    git -C ${patchedDir} add -A\n` +
        `    git -C ${patchedDir} commit`,
    );
  }

  const oldSeries = new Map(
    listSeriesPatches(name, version).map((patch) => [basename(patch), readFileSync(patch, "utf8")]),
  );

  mkdirSync(seriesDir, { recursive: true });
  for (const f of readdirSync(seriesDir)) {
    if (f.endsWith(".patch")) rmSync(join(seriesDir, f));
  }

  const out = git(
    ["format-patch", "-N", "--zero-commit", "--no-signature", "-o", seriesDir, "vendor-base..HEAD"],
    patchedDir,
  ).trim();
  const written = out ? out.split("\n").length : 0;
  log(`${name}-${version}: wrote ${written} patch(es)`);

  for (const patch of listSeriesPatches(name, version)) {
    const content = readFileSync(patch, "utf8");
    const normalized = normalizePatchWhitespace(content);
    const oldContent = oldSeries.get(basename(patch));
    writeFileSync(
      patch,
      oldContent && normalizePatchWhitespace(oldContent) === normalized ? oldContent : normalized,
    );
  }

  verifyRoundTrip({ name, version, patchedDir });

  writeFileSync(
    join(patchedDir, ".patch-sha8"),
    seriesSha8(listSeriesPatches(name, version)) + "\n",
  );
  return seriesDir;
}

function verifyRoundTrip({ name, version, patchedDir }) {
  const scratch = mkdtempSync(join(tmpdir(), `regen-${name}-`));
  try {
    const work = join(scratch, `${name}-${version}`);
    materialiseInto(
      work,
      findRegistrySource(name, version),
      name,
      version,
      listSeriesPatches(name, version),
    );
    try {
      execFileSync(
        "diff",
        ["-r", "--exclude=.git", "--exclude=.patched", "--exclude=.patch-sha8", work, patchedDir],
        { encoding: "utf8" },
      );
    } catch (e) {
      const out = (e.stdout || "") + (e.stderr || "");
      throw new Error(
        `round-trip verification failed for ${name}-${version}.\n` +
          `Re-applying the regenerated series does NOT reproduce the ` +
          `vendor-patched tree:\n${out}`,
      );
    }
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {}
  }
}

function main() {
  const argv = process.argv.slice(2);
  const filter = argv.length > 0 ? new Set(argv) : null;
  const targets = filter
    ? CRATES.filter((c) => filter.has(c.name) || filter.has(`${c.name}-${c.version}`))
    : CRATES;
  if (targets.length === 0) {
    log(`no crate matched filter: ${[...filter].join(", ")}`);
    log(`known crates: ${CRATES.map((c) => c.name).join(", ")}`);
    process.exit(2);
  }
  for (const crate of targets) {
    regenOne(crate);
  }
  log("done. Review with: git diff -- scripts/patches/");
}

main();
