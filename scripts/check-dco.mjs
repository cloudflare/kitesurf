#!/usr/bin/env node
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Checks that every non-merge commit in <base>..<head> carries a Developer
// Certificate of Origin sign-off by its author. See CONTRIBUTING.md and
// https://developercertificate.org/.
// Usage: node scripts/check-dco.mjs <base> <head>

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SIGN_OFF = /^Signed-off-by: .+ <([^<>\s]+)>\s*$/gm;
const FIELD = "\x1f";
const RECORD = "\x1e";

/** @typedef {{ sha: string, authorEmail: string, subject: string, message: string }} LogCommit */

/** Returns the commits whose message lacks a sign-off matching the author email.
 * @param {readonly LogCommit[]} commits
 * @returns {LogCommit[]} */
export function unsignedCommits(commits) {
  return commits.filter(({ authorEmail, message }) => {
    const author = authorEmail.toLowerCase();
    return ![...message.matchAll(SIGN_OFF)].some((m) => m[1].toLowerCase() === author);
  });
}

/** Parses `git log` output written with FIELD/RECORD separators.
 * @param {string} output
 * @returns {LogCommit[]} */
export function parseLog(output) {
  return output
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.length > 0)
    .map((record) => {
      const [sha = "", authorEmail = "", subject = "", message = ""] = record.split(FIELD);
      return { sha, authorEmail, subject, message };
    });
}

function main([base, head]) {
  if (!base || !head) {
    console.error("usage: node scripts/check-dco.mjs <base> <head>");
    return 2;
  }
  const output = execFileSync(
    "git",
    [
      "log",
      "--no-merges",
      `--format=%H${FIELD}%ae${FIELD}%s${FIELD}%B${RECORD}`,
      `${base}..${head}`,
    ],
    { encoding: "utf8" },
  );
  const missing = unsignedCommits(parseLog(output));
  if (missing.length === 0) return 0;
  console.error("These commits lack a Signed-off-by line matching their author email:");
  for (const c of missing) console.error(`  ${c.sha.slice(0, 12)} ${c.subject} <${c.authorEmail}>`);
  console.error(`Add sign-offs with: git rebase --signoff ${base}`);
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main(process.argv.slice(2));
}
