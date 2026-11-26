// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { groupAlive, stopProcessGroup } from "./process-group.mjs";

// Starts `script` as a detached group with a grandchild, the shape of `npx wrangler dev`.
async function startGroup(script) {
  const child = spawn("sh", ["-c", `${script}; sh -c 'sleep 30' & wait`], {
    detached: true,
    stdio: "ignore",
  });
  await sleep(200);
  return child;
}

test("SIGTERM lets the group run its exit hook", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "process-group-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scratch = join(dir, "dev-bundle");
  const child = await startGroup(`mkdir ${scratch}; trap 'rm -r ${scratch}; exit 0' TERM`);
  assert.ok(existsSync(scratch));
  assert.equal(await stopProcessGroup(child.pid, 5_000), true);
  assert.equal(groupAlive(child.pid), false);
  assert.equal(existsSync(scratch), false);
});

test("SIGKILL stops a group that outlives the grace period", async () => {
  const child = await startGroup("trap '' TERM");
  const t0 = Date.now();
  assert.equal(await stopProcessGroup(child.pid, 300), false);
  assert.ok(Date.now() - t0 >= 300);
  await sleep(100);
  assert.equal(groupAlive(child.pid), false);
});

test("a missing group is already stopped", async () => {
  assert.equal(await stopProcessGroup(undefined), true);
  assert.equal(await stopProcessGroup(1), true);
});
