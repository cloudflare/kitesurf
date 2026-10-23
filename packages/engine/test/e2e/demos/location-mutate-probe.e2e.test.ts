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
    const thrownMessage = (error: unknown) =>
      (error as { message?: string } | null)?.message ?? String(error);
    const captureError = (run: () => void): string | null => {
      try {
        run();
        return null;
      } catch (error) {
        return thrownMessage(error);
      }
    };

    window.addEventListener(
      "hashchange",
      (event) => {
        document.documentElement.setAttribute("data-location-mutate-event", event.type);
      },
      { once: true },
    );

    const assignmentThrew = captureError(() => {
      location.hash = "/foo";
    });
    const afterHash = location.hash;

    captureError(() => {
      location.hash = "#bar";
    });
    const afterHashWithPrefix = location.hash;

    const assignThrew = captureError(() => {
      location.assign("#baz");
    });
    const afterAssign = location.hash;

    const hrefThrew = captureError(() => {
      location.href = location.href.split("#")[0] + "#qux";
    });
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
