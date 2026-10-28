// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `bazel run //scripts:lint` starts in its runfiles tree; it lints the workspace it was run from.
const WORKSPACE = process.env.BUILD_WORKSPACE_DIRECTORY;
export const ROOT = resolve(WORKSPACE ?? process.cwd());
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * An npm package's executable as `[node, [script]]`, resolved beside this file.
 * @param {string} name @returns {[string, string[]]}
 */
export function packageBin(name) {
  const manifest = createRequire(import.meta.url).resolve(`${name}/package.json`);
  const bin = JSON.parse(readFileSync(manifest, "utf8")).bin;
  const entry = typeof bin === "string" ? bin : bin?.[name];
  if (typeof entry !== "string") throw new Error(`${name} declares no "${name}" executable`);
  return [process.execPath, [resolve(dirname(manifest), entry)]];
}

// Under `bazel run`, a config copy whose JS plugins load from runfiles, so imports use Bazel's
// npm tree. Its ignorePatterns stop matching from the copy's directory, which is safe because
// callers pass files that sourceFiles() already filtered by them.
/** @returns {string} */
export function oxlintConfigPath() {
  const configPath = resolve(ROOT, ".oxlintrc.json");
  if (!WORKSPACE) return configPath;
  const directory = mkdtempSync(join(tmpdir(), "kitesurf-oxlint-"));
  process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
  return copyOxlintConfig(configPath, directory);
}

// A host workspace's config extends the engine's by a relative path, so extended configs are copied
// too. A plugin path resolves from its config's directory; one that also exists under this
// tooling's root (the engine's own scripts/lint) loads from there.
/** @param {string} configPath @param {string} directory @returns {string} */
function copyOxlintConfig(configPath, directory) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const configDir = dirname(configPath);
  const toolsRoot = fileURLToPath(new URL("../../", import.meta.url));
  if (Array.isArray(config.jsPlugins)) {
    config.jsPlugins = config.jsPlugins.map((plugin) => {
      if (typeof plugin !== "string" || !plugin.startsWith(".")) return plugin;
      const inTools = join(toolsRoot, relative(configDir, resolve(configDir, plugin)));
      return existsSync(inTools) ? inTools : resolve(configDir, plugin);
    });
  }
  if (Array.isArray(config.extends)) {
    config.extends = config.extends.map((base) =>
      typeof base === "string" && base.startsWith(".")
        ? copyOxlintConfig(resolve(configDir, base), directory)
        : base,
    );
  }
  const copy = join(mkdtempSync(join(directory, "config-")), "oxlintrc.json");
  writeFileSync(copy, JSON.stringify(config));
  return copy;
}

function exclusionsFor(configFile) {
  const configPath = resolve(ROOT, configFile);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (
    !Array.isArray(config.ignorePatterns) ||
    !config.ignorePatterns.every((pattern) => typeof pattern === "string")
  ) {
    throw new Error(`${configFile} must define string ignorePatterns for authored-source checks`);
  }
  return config.ignorePatterns.map((pattern) => `:(glob,exclude)${pattern}`);
}

/** @param {string[]} extensions @param {string} configFile @returns {string[]} */
export function sourceFiles(extensions, configFile = ".oxlintrc.json") {
  return execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...extensions.map((extension) => `*.${extension}`),
      ...exclusionsFor(configFile),
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES },
  )
    .split("\0")
    .filter((file) => file.length > 0 && existsSync(resolve(ROOT, file)));
}
