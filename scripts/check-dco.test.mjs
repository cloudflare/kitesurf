// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseLog, unsignedCommits } from "./check-dco.mjs";

const commit = (authorEmail, message) => ({ sha: "a", authorEmail, subject: "s", message });

test("accepts a sign-off by the author, ignoring email case", () => {
  const signed = commit("Dev@Example.com", "fix: x\n\nSigned-off-by: Dev <dev@example.com>\n");
  assert.deepEqual(unsignedCommits([signed]), []);
});

test("rejects a missing sign-off and a sign-off by someone else", () => {
  const none = commit("dev@example.com", "fix: x\n");
  const other = commit("dev@example.com", "fix: x\n\nSigned-off-by: Other <other@example.com>\n");
  assert.deepEqual(unsignedCommits([none, other]), [none, other]);
});

test("rejects a sign-off that is not on its own line", () => {
  const inline = commit("dev@example.com", "see Signed-off-by: Dev <dev@example.com> later\n");
  assert.deepEqual(unsignedCommits([inline]), [inline]);
});

test("the CLI fails only on unsigned commits in the range", () => {
  const dir = mkdtempSync(join(tmpdir(), "kitesurf-dco-"));
  // Isolate from the developer's global git config, hooks and signing.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" }).trim();
  const script = new URL("./check-dco.mjs", import.meta.url).pathname;
  const run = (range) => {
    try {
      execFileSync("node", [script, ...range], { cwd: dir, env, stdio: "pipe" });
      return 0;
    } catch (error) {
      return error.status;
    }
  };
  try {
    git("init", "-q");
    git("config", "user.email", "dev@example.com");
    git("config", "user.name", "Dev");
    writeFileSync(join(dir, "f"), "1");
    git("add", "f");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "f"), "2");
    git("commit", "-q", "-a", "-s", "-m", "signed");
    const signed = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "f"), "3");
    git("commit", "-q", "-a", "-m", "unsigned");
    assert.equal(run([base, signed]), 0);
    assert.equal(run([base, "HEAD"]), 1);
    assert.equal(parseLog(git("log", "--format=%H%x1f%ae%x1f%s%x1f%B%x1e", "-1")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
