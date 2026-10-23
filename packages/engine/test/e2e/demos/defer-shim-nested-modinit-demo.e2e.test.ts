// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

type ProbeSnapshot = Partial<
  Record<"setTimeout" | "fetch" | "getRandomValues" | "subtleDigest", string>
>;
type NestedModinitWindow = Window & {
  __probe?: {
    logs: string[];
    initSync: ProbeSnapshot | null;
    initAsync: ProbeSnapshot | null;
    postSync: ProbeSnapshot | null;
    postAsync: ProbeSnapshot | null;
    error: string | null;
  };
};

function snapshotOrEmpty(snapshot: ProbeSnapshot | null | undefined): ProbeSnapshot {
  return snapshot ?? {};
}

function assertSyncSnapshot(snapshot: ProbeSnapshot, phase: string): void {
  for (const key of ["setTimeout", "fetch", "getRandomValues", "subtleDigest"] as const) {
    expect(
      String(snapshot[key] ?? "").startsWith("ok"),
      `${phase} sync ${key} did not throw: got: ${JSON.stringify(snapshot[key])}`,
    ).toBeTruthy();
  }
}

function assertAsyncSnapshot(snapshot: ProbeSnapshot, phase: string): void {
  expect(
    snapshot.setTimeout === "fired",
    `${phase} async setTimeout fired: got: ${JSON.stringify(snapshot.setTimeout)}`,
  ).toBeTruthy();
  expect(
    String(snapshot.fetch ?? "").startsWith("status="),
    `${phase} async fetch resolved: got: ${JSON.stringify(snapshot.fetch)}`,
  ).toBeTruthy();
  expect(
    snapshot.subtleDigest === "ok(bytes=32)",
    `${phase} async subtle.digest resolved: got: ${JSON.stringify(snapshot.subtleDigest)}`,
  ).toBeTruthy();
}

test("defer-shim-nested-modinit-demo", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/nested-modinit.html");
  await new Promise((r) => setTimeout(r, 1500));

  const probe = await page.evaluate(() => (window as NestedModinitWindow).__probe);

  expect(!!probe, "probe captured: no __probe found").toBeTruthy();
  expect(probe.error == null, "no error during settlement: " + (probe.error || "")).toBeTruthy();
  const initSync = snapshotOrEmpty(probe.initSync);
  const initAsync = snapshotOrEmpty(probe.initAsync);
  const postSync = snapshotOrEmpty(probe.postSync);
  const postAsync = snapshotOrEmpty(probe.postAsync);
  assertSyncSnapshot(initSync, "init");
  assertAsyncSnapshot(initAsync, "init");
  assertSyncSnapshot(postSync, "post");
  assertAsyncSnapshot(postAsync, "post");
});
