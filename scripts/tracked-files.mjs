// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Tracked-file selection shared by the public workspace checks and their Bazel actions.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** @param {string} pathspec @returns {(file: string) => boolean} */
function matcher(pathspec) {
  if (!/[*?[]/.test(pathspec))
    return (file) => file === pathspec || file.startsWith(`${pathspec}/`);
  const source = pathspec
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  const regex = new RegExp(`^${source}$`);
  return (file) => regex.test(file);
}

/** @param {string} root @param {string[]} pathspecs @returns {string[]} */
export function trackedFiles(root, pathspecs) {
  const list = process.env.KITESURF_TRACKED_FILES;
  if (!list) {
    return execFileSync("git", ["ls-files", "--", ...pathspecs], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  }
  const excludes = pathspecs
    .filter((item) => item.startsWith(":(exclude)"))
    .map((item) => matcher(item.slice(10)));
  const includes = pathspecs.filter((item) => !item.startsWith(":(exclude)")).map(matcher);
  return readFileSync(list, "utf8")
    .split("\n")
    .filter(
      (file) =>
        file &&
        (!includes.length || includes.some((match) => match(file))) &&
        !excludes.some((match) => match(file)),
    );
}
