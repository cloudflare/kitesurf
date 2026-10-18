// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// heal_at_entry clears the VM stack only at an outermost, idle entry. Nested crossings
// must keep their arguments, and clean ones must leave nothing behind for it to clear.
import { expect } from "vitest";

import { test } from "./harness";
import { setContent } from "./set-content";
import type { Page } from "@cloudflare/puppeteer";
import { targetIdForSession } from "./connect";

async function healedAtEntry(page: Page): Promise<number> {
  const session = await page.createCDPSession();
  const targetId = await targetIdForSession(session);
  const stats = await session.send("Kitesurf.getMemoryStats", { targetId });
  await session.detach().catch(() => {});
  if (!stats.bridge) throw new Error("no bridge gauges in getMemoryStats");
  return stats.bridge.healedAtEntry;
}

test("nested boa entries keep their arguments and leave nothing to heal", async ({ page }) => {
  await setContent(
    page,
    `<script>
      window.apply2 = (f, a, b) => f(a, b);
      window.later = (g, y) => new Promise((resolve) => setTimeout(() => resolve(g(y)), 0));
    </script>`,
  );
  const before = await healedAtEntry(page);
  const got = await page.evaluate(async () => {
    const apply2: unknown = Reflect.get(globalThis, "apply2");
    const later: unknown = Reflect.get(globalThis, "later");
    if (typeof apply2 !== "function" || typeof later !== "function")
      throw new Error("missing helpers");
    const sum = (a: number, b: number) => a + b;
    // V8 enters this bound function with no boa frame, its arguments on the VM stack,
    // and its V8 target re-enters boa: healing there would drop them.
    const bound = apply2.bind(null, sum, 5);
    const viaTimer: unknown[] = [];
    for (let i = 0; i < 50; i++) viaTimer.push(await later(bound, i));
    const nested = [1, 2, 3].map((x) =>
      apply2((a: number, b: number) => apply2(sum, a, b * 10), x, x),
    );
    return { viaTimer, nested };
  });
  expect(got.viaTimer).toEqual(Array.from({ length: 50 }, (_, i) => 5 + i));
  expect(got.nested).toEqual([11, 22, 33]);
  expect(await healedAtEntry(page), "clean crossings strand nothing").toBe(before);
});
