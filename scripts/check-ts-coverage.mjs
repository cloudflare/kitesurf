// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { trackedFiles } from "./tracked-files.mjs";

const root = resolve(import.meta.dirname, "..");
const host = { ...ts.sys };
if (process.env.KITESURF_TRACKED_FILES) {
  const entries = new Map();
  for (const file of trackedFiles(root, [])) {
    let dir = root;
    for (const part of file.split("/").slice(0, -1)) {
      const sub = resolve(dir, part);
      if (!entries.has(dir)) entries.set(dir, { files: [], directories: [] });
      if (!entries.get(dir).directories.includes(part)) entries.get(dir).directories.push(part);
      dir = sub;
    }
    if (!entries.has(dir)) entries.set(dir, { files: [], directories: [] });
    entries.get(dir).files.push(file.split("/").at(-1));
  }
  const empty = { files: [], directories: [] };
  host.readDirectory = (path, extensions, excludes, includes, depth) =>
    ts.matchFiles(
      path,
      extensions,
      excludes,
      includes,
      true,
      root,
      depth,
      (dir) => entries.get(resolve(dir)) ?? empty,
      (path) => path,
    );
}

function tsconfigsFromScript(pkgDir, command) {
  const found = [];
  for (const step of command.split(/&&|;/)) {
    const words = step.trim().split(/\s+/);
    if (words[0] !== "tsc") continue;
    const flag = words.findIndex((w) => w === "-p" || w === "--project");
    found.push(resolve(pkgDir, flag === -1 ? "tsconfig.json" : words[flag + 1]));
  }
  return found;
}

// Only tsconfigs invoked by package types scripts count as checked coverage.
const tsconfigs = new Set();
for (const manifest of trackedFiles(root, [
  "package.json",
  "*/package.json",
  ":(exclude)vendor/**",
])) {
  const pkgDir = resolve(root, dirname(manifest));
  const { scripts = {} } = JSON.parse(readFileSync(resolve(root, manifest), "utf8"));
  for (const [name, command] of Object.entries(scripts)) {
    if (name !== "types" && !name.startsWith("types:")) continue;
    for (const config of tsconfigsFromScript(pkgDir, command)) tsconfigs.add(config);
  }
}

const problems = [];
const covered = new Set();
for (const configPath of tsconfigs) {
  const label = relative(root, configPath);
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error) {
    problems.push(`${label}: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`);
    continue;
  }
  const parsed = ts.parseJsonConfigFileContent(config, host, dirname(configPath));
  if (parsed.options.types === undefined) {
    problems.push(
      `${label}: set compilerOptions.types (an unset value pulls in every @types/* package)`,
    );
  }
  for (const file of parsed.fileNames) covered.add(relative(root, file));
}

// Declarations are rejected by check-no-dts; this guard covers implementation sources.
const uncovered = trackedFiles(root, [
  "*.ts",
  "*.tsx",
  "*.mts",
  "*.cts",
  ":(exclude)*.d.ts",
  ":(exclude)*.d.*.ts",
  ":(exclude)vendor/**",
]).filter((file) => !covered.has(file));
if (uncovered.length) {
  problems.push(
    "not in any typechecked tsconfig (add it to an `include`, or add a " +
      "tsconfig and run it from a `types` script):\n" +
      uncovered.map((f) => `    ${f}`).join("\n"),
  );
}

if (problems.length) {
  console.error(
    "TypeScript coverage check failed (see scripts/check-ts-coverage.mjs):\n" +
      problems.map((p) => `  ${p}`).join("\n"),
  );
  process.exit(1);
}
