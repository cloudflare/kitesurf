// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// `bazel run //packages/engine:dev_build`: copy the Bazel-built wasm, bundles and RBI files to the
// source-tree paths `wrangler dev` reads, so the engine runs from source and its src/ hot-reloads.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

// Each entry is a directory relative to both trees. The source-tree copy is emptied first, except
// for its committed files (`keep`), so no output of an earlier build, such as memprof's, survives.
const OUTPUTS = [
  { dir: "packages/core/pkg", keep: ["package.json", "BUILD.bazel"] },
  { dir: "packages/renderer-core/pkg" },
  { dir: "packages/engine/public/rbi" },
  { dir: "packages/dom-shim/dist" },
  { dir: "packages/page-script/dist" },
  { dir: "packages/page-renderer/dist" },
  { dir: "packages/worker-script/dist" },
];
const MEMPROF_ONLY = process.argv.includes("--memprof");

// Runfiles are links into bazel-out, so follow them. Copies keep Bazel's read-only mode, which
// would stop an editor or the next run from replacing them.
function copyTree(source, target) {
  if (!statSync(source).isDirectory()) {
    rmSync(target, { force: true });
    copyFileSync(source, target);
    chmodSync(target, 0o644);
    return 1;
  }
  mkdirSync(target, { recursive: true });
  let files = 0;
  for (const name of readdirSync(source)) files += copyTree(join(source, name), join(target, name));
  return files;
}

// An embedding workspace can stage into the engine checkout instead of its own root.
const workspace = process.env.KITESURF_SOURCE_ROOT ?? process.env.BUILD_WORKSPACE_DIRECTORY;
if (!workspace) {
  const target = MEMPROF_ONLY ? "//packages/core/pkg:stage_memprof" : "//packages/engine:dev_build";
  console.error(`[dev-build] run this through \`bazel run ${target}\``);
  process.exit(2);
}
const runfiles = resolve(import.meta.dirname, "..");

const stageDirectory = (source, destination, keep = []) => {
  const from = join(runfiles, source);
  if (!existsSync(from)) {
    console.error(`[dev-build] ${source} is missing from the build outputs`);
    process.exit(1);
  }
  const to = join(workspace, destination);
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(to)) {
    if (!keep.includes(name)) rmSync(join(to, name), { recursive: true, force: true });
  }
  let copied = 0;
  for (const name of readdirSync(from)) {
    if (keep.includes(name)) continue;
    copied += copyTree(join(from, name), join(to, name));
  }
  console.log(`[dev-build] ${destination}: ${copied} file(s)`);
};

if (MEMPROF_ONLY) {
  stageDirectory("packages/core/pkg/memprof", "packages/core/pkg", ["package.json", "BUILD.bazel"]);
} else {
  for (const { dir, keep = [] } of OUTPUTS) stageDirectory(dir, dir, keep);
}
console.log(`[dev-build] staged into ${workspace}`);
