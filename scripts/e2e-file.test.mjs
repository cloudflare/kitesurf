// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const RUNNER = resolve(import.meta.dirname, "e2e-file.mjs");
const TEST_FILE = "test/e2e/example.e2e.test.ts";

// A fake vitest under an external repository's engine directory. It fails its first `failures`
// runs, counting runs in runs.txt next to the engine.
function fixture(t, failures) {
  const root = mkdtempSync(join(tmpdir(), "kitesurf-external-e2e-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const engine = join(root, "external/kitesurf+/packages/engine");
  const vitest = join(engine, "node_modules/vitest");
  mkdirSync(vitest, { recursive: true });
  writeFileSync(join(engine, "package.json"), '{"type":"module"}');
  writeFileSync(join(vitest, "package.json"), '{"bin":{"vitest":"cli.mjs"}}');
  writeFileSync(
    join(vitest, "cli.mjs"),
    `import { existsSync, readFileSync, writeFileSync } from "node:fs";
const runs = existsSync("runs.txt") ? Number(readFileSync("runs.txt", "utf8")) + 1 : 1;
writeFileSync("runs.txt", String(runs));
const failed = runs <= ${failures};
const output = process.argv.find((arg) => arg.startsWith("--outputFile.json="));
writeFileSync(output.slice("--outputFile.json=".length), JSON.stringify({
  testResults: [{
    name: process.cwd() + "/${TEST_FILE}",
    status: failed ? "failed" : "passed",
    assertionResults: [{ fullName: "example", status: failed ? "failed" : "passed" }],
  }],
}));
process.exit(failed ? 1 : 0);
`,
  );
  const out = join(root, "results");
  const result = spawnSync(
    process.execPath,
    [
      RUNNER,
      "--engine-dir",
      engine,
      "--engine-dist",
      "dist",
      "--fixtures-dist",
      "fixtures",
      "--out-dir",
      out,
      TEST_FILE,
    ],
    { cwd: root, encoding: "utf8", env: { ...process.env, BAZEL_BINDIR: "bazel-out/bin" } },
  );
  return { result, out };
}

test("e2e files resolve Vitest and tests from the external engine directory", (t) => {
  const { result, out } = fixture(t, 0);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(readFileSync(join(out, "file.json"), "utf8"));
  assert.equal(summary.file, TEST_FILE);
  assert.equal(summary.attempts, 1);
});

test("an e2e file that passes on its retry succeeds", (t) => {
  const { result, out } = fixture(t, 1);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(out, "file.json"), "utf8")).attempts, 2);
});

test("an e2e file that fails its retry fails the action", (t) => {
  const { result, out } = fixture(t, 2);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /failed twice:\n {2}FAIL example/);
  assert.equal(existsSync(join(out, "file.json")), false);
});
