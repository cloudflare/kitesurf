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

test("defer-shim-nested-modinit-demo", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/nested-modinit.html");
  await new Promise((r) => setTimeout(r, 1500));

  const probe = await page.evaluate(() => (window as NestedModinitWindow).__probe);

  expect(!!probe, "probe captured: no __probe found").toBeTruthy();
  expect(probe.error == null, "no error during settlement: " + (probe.error || "")).toBeTruthy();

  for (const k of ["setTimeout", "fetch", "getRandomValues", "subtleDigest"]) {
    expect(
      String(probe.initSync?.[k] ?? "").startsWith("ok"),
      "init sync " + k + " did not throw: got: " + JSON.stringify(probe.initSync?.[k]),
    ).toBeTruthy();
  }

  expect(
    probe.initAsync?.setTimeout === "fired",
    "init async setTimeout fired: got: " + JSON.stringify(probe.initAsync?.setTimeout),
  ).toBeTruthy();
  expect(
    String(probe.initAsync?.fetch ?? "").startsWith("status="),
    "init async fetch resolved: got: " + JSON.stringify(probe.initAsync?.fetch),
  ).toBeTruthy();
  expect(
    probe.initAsync?.subtleDigest === "ok(bytes=32)",
    "init async subtle.digest resolved: got: " + JSON.stringify(probe.initAsync?.subtleDigest),
  ).toBeTruthy();

  for (const k of ["setTimeout", "fetch", "getRandomValues", "subtleDigest"]) {
    expect(
      String(probe.postSync?.[k] ?? "").startsWith("ok"),
      "post sync " + k + " did not throw: got: " + JSON.stringify(probe.postSync?.[k]),
    ).toBeTruthy();
  }
  expect(
    probe.postAsync?.setTimeout === "fired",
    "post async setTimeout fired: got: " + JSON.stringify(probe.postAsync?.setTimeout),
  ).toBeTruthy();
  expect(
    String(probe.postAsync?.fetch ?? "").startsWith("status="),
    "post async fetch resolved: got: " + JSON.stringify(probe.postAsync?.fetch),
  ).toBeTruthy();
  expect(
    probe.postAsync?.subtleDigest === "ok(bytes=32)",
    "post async subtle.digest resolved: got: " + JSON.stringify(probe.postAsync?.subtleDigest),
  ).toBeTruthy();
});
