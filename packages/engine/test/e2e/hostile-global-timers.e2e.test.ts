// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

const BASE = "https://ks.invalid/__fixtures";

test("load fires promptly when page JS breaks globalThis timers", async ({
  page,
  cdpSession: cdp,
}) => {
  await cdp.send("Page.enable");
  await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });

  const seen: Array<{ name: string; at: number }> = [];
  const t0 = Date.now();
  let onLoad!: (at: number) => void;
  const loadSeen = new Promise<number>((resolve) => {
    onLoad = resolve;
  });
  cdp.on("Page.lifecycleEvent", (e) => {
    const at = Date.now() - t0;
    const name = (e as { name: string }).name;
    seen.push({ name, at });
    if (name === "load") onLoad(at);
  });

  await page.goto(`${BASE}/hostile-timers.html`, {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });

  const at = await Promise.race([
    loadSeen,
    new Promise<number>((_, reject) =>
      setTimeout(
        () => reject(new Error(`no load lifecycle in 15s; saw ${JSON.stringify(seen)}`)),
        15_000,
      ),
    ),
  ]);
  expect(at).toBeLessThan(15_000);

  const title = await page.title();
  expect(title).toBe("HOSTILE_TIMERS_INSTALLED");
});
