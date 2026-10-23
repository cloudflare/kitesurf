// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// WPT's implementation is by Aryeh Gregor under the 3-Clause BSD license:
// https://github.com/web-platform-tests/wpt/blob/master/LICENSE.md

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WPT_EDITING_REV = "6efb1b12b95725c026cb1f5a451138345cfca937";
const UPSTREAM_SHA256 = "0e9721527b1323d7c39512bedc52ad22f3c0493678471df44585a1defea59cfc";
const UPSTREAM_PATH = "editing/include/implementation.js";
const UPSTREAM_URL = `https://raw.githubusercontent.com/web-platform-tests/wpt/${WPT_EDITING_REV}/${UPSTREAM_PATH}`;
const MAX_DOWNLOAD_ATTEMPTS = 3;
const DOWNLOAD_TIMEOUT_MS = 30_000;

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PATCH_DIR = resolve(PKG_ROOT, "patches/wpt-editing");
const CACHE_FILE = resolve(PKG_ROOT, `node_modules/.cache/wpt-editing/${WPT_EDITING_REV}.js`);
const OUT_FILE = resolve(PKG_ROOT, "src/editing/implementation.js");

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

async function readCached() {
  try {
    const text = await readFile(CACHE_FILE, "utf8");
    if (sha256(text) === UPSTREAM_SHA256) return text;
  } catch {}
  return null;
}

async function download() {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      return await downloadOnce();
    } catch (err) {
      if (err.fatal) throw err;
      lastErr = err;
    }
  }
  throw downloadError(lastErr);
}

function downloadError(lastErr) {
  return new Error(`[dom-shim] could not download ${UPSTREAM_URL}: ${lastErr?.message ?? lastErr}`);
}

async function downloadOnce() {
  const res = await fetch(UPSTREAM_URL, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const got = sha256(text);
  if (got !== UPSTREAM_SHA256) {
    throw Object.assign(new Error(`sha256 mismatch: expected ${UPSTREAM_SHA256}, got ${got}`), {
      fatal: true,
    });
  }
  await mkdir(dirname(CACHE_FILE), { recursive: true });
  await writeFile(CACHE_FILE, text);
  return text;
}

async function applySeries(upstream) {
  const patches = (await readdir(PATCH_DIR)).filter((f) => f.endsWith(".patch")).sort();
  const work = await mkdtemp(join(tmpdir(), "wpt-editing-"));
  try {
    const file = join(work, UPSTREAM_PATH);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, upstream);
    for (const p of patches) {
      execFileSync("git", ["apply", join(PATCH_DIR, p)], {
        cwd: work,
        env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(work) },
        stdio: ["ignore", "inherit", "inherit"],
      });
    }
    return await readFile(file, "utf8");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** @returns {Promise<void>} */
export async function materializeEditingImplementation() {
  // Bazel actions have no network or git, so editing_repo.bzl fetches and patches the file from
  // this script's pin and series and the build passes the result in this variable.
  const patched = process.env.KITESURF_WPT_EDITING_IMPLEMENTATION;
  const out = patched
    ? await readFile(patched, "utf8")
    : await applySeries((await readCached()) ?? (await download()));
  let current = null;
  try {
    current = await readFile(OUT_FILE, "utf8");
  } catch {}
  if (current !== out) await writeFile(OUT_FILE, out);
}
