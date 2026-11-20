// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import type { Protocol } from "devtools-protocol";

test("font-heavy-eagerness", async ({ page, cdpSession }) => {
  const DECLARED = 12;
  const USED = 3;
  await cdpSession.send("Network.enable", {});
  const fontRequests = new Set<string>();
  cdpSession.on("Network.requestWillBeSent", (event: Protocol.Network.RequestWillBeSentEvent) => {
    const url = event.request.url;
    if (url.includes("noto-var-latin-subset.woff2")) fontRequests.add(url);
  });

  await page.goto(
    `http://127.0.0.1:8787/__fixtures/font-heavy.html?declared=${DECLARED}&used=${USED}`,
    { timeout: 20_000 },
  );
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ type: "png" });

  const mem = await cdpSession.send("Kitesurf.getMemoryStats", {});
  const m = Object.values(mem.byTarget ?? {}).find((t) => (t?.wasmBytes ?? 0) > 0);
  console.log(
    `[font-heavy] declared=${DECLARED} used=${USED} fontFetches=${fontRequests.size}`,
    "urls:",
    [...fontRequests].map((u) => u.split("?")[1]).join(","),
  );
  console.log(
    `[font-heavy] pageScript wasm delta: ${((m?.wasmDeltaBytes ?? 0) / 1048576).toFixed(1)}MB`,
  );

  expect(fontRequests.size, "font fetch count stays within used-face count").toBeLessThanOrEqual(
    USED,
  );
  expect(fontRequests.size, "used faces actually fetched").toBeGreaterThan(0);
});

test("document.fonts.ready delegates to the lazy-font hook", async ({ page }) => {
  await page.goto("http://127.0.0.1:8787/__fixtures/font-heavy.html?declared=1&used=1", {
    timeout: 20_000,
  });
  const observed = await page.evaluate(async () => {
    const g: unknown = Reflect.get(globalThis, Symbol.for("kitesurf.internals"));
    if (typeof g !== "object" || g === null) throw new Error("no internals record");
    const hooksPresent =
      typeof Reflect.get(g, "fontsReady") === "function" &&
      typeof Reflect.get(g, "fontsInflightCount") === "function";

    let inflight = 2;
    let resolveGate!: () => void;
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });
    Reflect.set(g, "fontsInflightCount", () => inflight);
    Reflect.set(g, "fontsReady", () => gate);

    const fonts = document.fonts;
    const statusWhileLoading = fonts.status;
    let resolved = false;
    const readyPromise = fonts.ready.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    const settledEarly = resolved;
    inflight = 0;
    resolveGate();
    await readyPromise;
    const statusAfter = fonts.status;
    return { hooksPresent, statusWhileLoading, settledEarly, statusAfter };
  });

  expect(observed.hooksPresent, "page-script published the hooks").toBe(true);
  expect(observed.statusWhileLoading, "status while inflight>0").toBe("loading");
  expect(observed.settledEarly, "ready did not resolve synchronously").toBe(false);
  expect(observed.statusAfter, "status after hook resolves").toBe("loaded");
});
