// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./format-rust.mjs", import.meta.url));

function withRepository(run) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kitesurf-format-rust-")));
  const bin = join(root, "bin");
  const argsFile = join(root, "bazel-args");
  const env = {
    ...process.env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    FORMATTER_ARGS: argsFile,
  };
  delete env.BUILD_WORKSPACE_DIRECTORY;
  try {
    mkdirSync(bin);
    execFileSync("git", ["init", "-q"], { cwd: root, env });
    writeFileSync(join(root, ".oxfmtrc.json"), JSON.stringify({ ignorePatterns: ["vendor/**"] }));
    writeFileSync(
      join(bin, "bazel"),
      '#!/bin/sh\nprintf "%s\\0" "$@" > "$FORMATTER_ARGS"\nexit "${FORMATTER_EXIT_CODE:-0}"\n',
      { mode: 0o755 },
    );
    run({ root, env, argsFile });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("passes existing tracked and untracked Rust files to rustfmt, excluding ignored and vendored files", () => {
  withRepository(({ root, env, argsFile }) => {
    mkdirSync(join(root, "vendor"));
    writeFileSync(join(root, ".gitignore"), "ignored.rs\n");
    for (const path of ["tracked.rs", "deleted.rs", "new file.rs", "ignored.rs", "vendor/lib.rs"]) {
      writeFileSync(join(root, path), "fn main() {}\n");
    }
    execFileSync("git", ["add", "tracked.rs", "deleted.rs"], { cwd: root, env });
    unlinkSync(join(root, "deleted.rs"));

    const result = spawnSync(process.execPath, [script], { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const args = readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
    assert.deepEqual(args.slice(0, 8), [
      "run",
      "@rust_tools//:rustfmt",
      "--",
      "--edition",
      "2021",
      "--config-path",
      join(root, "rustfmt.toml"),
      "--config",
    ]);
    assert.equal(args[8], "skip_children=true");
    assert.deepEqual(args.slice(9).sort(), [join(root, "new file.rs"), join(root, "tracked.rs")]);
  });
});

test("propagates formatter failures and skips the formatter when there are no Rust files", () => {
  withRepository(({ root, env, argsFile }) => {
    const noFiles = spawnSync(process.execPath, [script], { cwd: root, env, encoding: "utf8" });
    assert.equal(noFiles.status, 0, noFiles.stderr);
    assert.equal(existsSync(argsFile), false);

    writeFileSync(join(root, "file.rs"), "fn main() {}\n");
    const failed = spawnSync(process.execPath, [script], {
      cwd: root,
      env: { ...env, FORMATTER_EXIT_CODE: "23" },
      encoding: "utf8",
    });
    assert.equal(failed.status, 23, failed.stderr);
  });
});
