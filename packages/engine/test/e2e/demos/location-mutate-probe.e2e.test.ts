// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("location mutation APIs update the hash", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/lifecycle.html", {
    waitUntil: "load",
    timeout: 15_000,
  });

  const probe = await page.evaluate(() => {
    let assignmentThrew: string | null = null;
    let assignThrew: string | null = null;
    let hrefThrew: string | null = null;

    window.addEventListener(
      "hashchange",
      (event) => {
        document.documentElement.setAttribute("data-location-mutate-event", event.type);
      },
      { once: true },
    );

    try {
      location.hash = "/foo";
    } catch (error) {
      assignmentThrew = (error as { message?: string } | null)?.message ?? String(error);
    }
    const afterHash = location.hash;

    try {
      location.hash = "#bar";
    } catch {}
    const afterHashWithPrefix = location.hash;

    try {
      location.assign("#baz");
    } catch (error) {
      assignThrew = (error as { message?: string } | null)?.message ?? String(error);
    }
    const afterAssign = location.hash;

    try {
      location.href = location.href.split("#")[0] + "#qux";
    } catch (error) {
      hrefThrew = (error as { message?: string } | null)?.message ?? String(error);
    }
    const afterHrefSet = location.hash;

    return {
      assignmentThrew,
      afterHash,
      afterHashWithPrefix,
      assignThrew,
      afterAssign,
      hrefThrew,
      afterHrefSet,
    };
  });

  await page
    .waitForFunction(
      () => document.documentElement.getAttribute("data-location-mutate-event") === "hashchange",
      { timeout: 15_000 },
    )
    .catch(() => {});
  const observedHashchange = await page.evaluate(() =>
    document.documentElement.getAttribute("data-location-mutate-event"),
  );

  expect(probe.assignmentThrew, "location.hash = '/foo' did not throw").toBeNull();
  expect(probe.afterHash, "location.hash reads back as '#/foo'").toBe("#/foo");
  expect(observedHashchange, "hashchange event fired with type='hashchange'").toBe("hashchange");
  expect(probe.afterHashWithPrefix, "location.hash = '#bar' normalizes to '#bar'").toBe("#bar");
  expect(probe.assignThrew, "location.assign did not throw").toBeNull();
  expect(probe.afterAssign, "location.assign('#baz') updated hash").toBe("#baz");
  expect(probe.hrefThrew, "location.href = ... did not throw").toBeNull();
  expect(probe.afterHrefSet, "location.href same-doc hash works").toBe("#qux");
});
