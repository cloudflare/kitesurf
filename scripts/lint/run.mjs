// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { ROOT, TOOLING_ROOT, oxlintConfigPath, packageBin, sourceFiles } from "./scope.mjs";

const CODE_EXTENSIONS = ["cjs", "cts", "js", "jsx", "mjs", "mts", "ts", "tsx"];
const FORMAT_EXTENSIONS = [
  ...CODE_EXTENSIONS,
  "css",
  "html",
  "json",
  "jsonc",
  "md",
  "mdx",
  "toml",
  "yaml",
  "yml",
];
const USAGE = `Usage:
  node scripts/lint/run.mjs format --check|--write
  node scripts/lint/run.mjs lint:js
  node scripts/lint/run.mjs lint:rust
  node scripts/lint/run.mjs lint
`;

function oxlintCommand() {
  const files = sourceFiles(CODE_EXTENSIONS, ".oxlintrc.json");
  if (files.length === 0) return null;
  const [node, oxlint] = packageBin("oxlint");
  return [
    node,
    [
      ...oxlint,
      "--config",
      oxlintConfigPath(),
      "--disable-nested-config",
      "--threads",
      "2",
      "--deny-warnings",
      ...files,
    ],
  ];
}

function rustCommands() {
  const lintScript = (name, ...args) => [
    process.execPath,
    [resolve(TOOLING_ROOT, "scripts/lint", name), ...args],
  ];
  return [
    lintScript("check-rust-nesting.mjs"),
    lintScript("check-rust-comments.mjs"),
    lintScript("rust.mjs", "lint"),
  ];
}

function formatCommands(mode) {
  if (mode !== "--check" && mode !== "--write") return null;
  const files = sourceFiles(FORMAT_EXTENSIONS, ".oxfmtrc.json");
  const [oxfmt, oxfmtArgs] = packageBin("oxfmt");
  const commands =
    files.length === 0
      ? []
      : [
          [
            oxfmt,
            [
              ...oxfmtArgs,
              "--config",
              resolve(ROOT, ".oxfmtrc.json"),
              "--disable-nested-config",
              mode,
              ...files,
            ],
          ],
        ];
  commands.push([
    process.execPath,
    [resolve(TOOLING_ROOT, "scripts/lint/rust.mjs"), "format", mode],
  ]);
  return commands;
}

function javascriptCommands() {
  const command = oxlintCommand();
  return command === null ? [] : [command];
}

function allLintCommands() {
  return [...javascriptCommands(), ...rustCommands()];
}

const lintCommandBuilders = new Map([
  ["lint:js", javascriptCommands],
  ["lint:rust", rustCommands],
  ["lint", allLintCommands],
]);

function commandsFor(operation, mode) {
  if (operation === "format") return formatCommands(mode);
  if (mode !== undefined) return null;
  return lintCommandBuilders.get(operation)?.() ?? null;
}

function reportLaunchFailure(command, result) {
  if (result.error !== undefined) {
    console.error(`[lint] Could not start ${command}: ${result.error.message}`);
    process.exitCode = 1;
    return true;
  }
  if (result.signal !== null) {
    console.error(`[lint] ${command} terminated after signal ${result.signal}`);
    process.exitCode = result.status ?? 1;
    return true;
  }
  return false;
}

function reportExitFailure(result) {
  if (result.status === 0) return false;
  process.exitCode = result.status ?? 1;
  return true;
}

function reportCommandFailure(command, result) {
  if (reportLaunchFailure(command, result)) return true;
  return reportExitFailure(result);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  return !reportCommandFailure(command, result);
}

function runCommands(commands) {
  for (const [command, args] of commands) {
    if (!runCommand(command, args)) return;
  }
}

const [operation, mode, ...extra] = process.argv.slice(2);
const validShape =
  (operation === "format" && extra.length === 0) ||
  (["lint", "lint:js", "lint:rust"].includes(operation ?? "") &&
    mode === undefined &&
    extra.length === 0);
const commands = validShape ? commandsFor(operation, mode) : null;
if (commands === null) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  try {
    runCommands(commands);
  } catch (error) {
    console.error(`[lint] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
