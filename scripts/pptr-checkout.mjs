// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// The pinned Puppeteer checkout the Bazel actions share, and the writable overlays built on it.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// --pptr-base, else KITESURF_PPTR_BASE, else .puppeteer in this checkout.
/** @param {string[]} argv @returns {string} */
export function checkoutBase(argv) {
  const index = argv.indexOf("--pptr-base");
  if (index >= 0) return resolve(argv[index + 1]);
  return resolve(process.env.KITESURF_PPTR_BASE ?? resolve(ROOT, ".puppeteer"));
}

/** @param {string} base @returns {string | null} why the checkout is unusable, or null */
export function checkoutProblem(base) {
  const tag = /const PPTR_TAG = "([^"]+)"/.exec(
    readFileSync(resolve(ROOT, "scripts/pptr-setup.mjs"), "utf8"),
  )?.[1];
  const packageFile = resolve(base, "packages/puppeteer/package.json");
  const version = existsSync(packageFile)
    ? JSON.parse(readFileSync(packageFile, "utf8")).version
    : "";
  if (!tag || tag !== `puppeteer-v${version}`)
    return `Puppeteer checkout at ${base} is ${version || "missing"}, setup pins ${tag}`;
  for (const built of ["test/build/mocha-utils.js", "tools/mocha-runner/bin/interface.js"])
    if (!existsSync(resolve(base, built))) return `${base} is not built; run pnpm run pptr:setup`;
  return null;
}

// A temporary directory that links every top-level entry of the read-only checkout except
// `test`, which the caller fills in.
/** @param {string} base @returns {string} */
export function overlay(base) {
  const directory = mkdtempSync(join(os.tmpdir(), "pptr-"));
  for (const name of readdirSync(base)) {
    if (name === ".git" || name === "test-results" || name === "test") continue;
    symlinkSync(resolve(base, name), resolve(directory, name));
  }
  return directory;
}

// Copies files, not links, and leaves them writable: sandboxes may stage Bazel inputs as read-only
// symlinks, Node 24's cpSync keeps nested ones even with `dereference`, and a golden mismatch
// writes test/output-<browser>/.
/** @param {string} source @param {string} destination @returns {void} */
export function copyWritable(source, destination) {
  mkdirSync(destination, { recursive: true });
  chmodSync(destination, 0o755);
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    const to = join(destination, name);
    if (statSync(from).isDirectory()) copyWritable(from, to);
    else {
      copyFileSync(from, to);
      chmodSync(to, 0o644);
    }
  }
}
