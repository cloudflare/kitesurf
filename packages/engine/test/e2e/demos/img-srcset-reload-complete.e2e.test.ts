// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("img-srcset-reload-complete", async ({ page }) => {
  const FIXTURE_URL =
    process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/image-heavy.html";

  await page.goto(FIXTURE_URL, { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const img = document.querySelector("img");
    if (!img) return { err: "no img in fixture" };
    if (!img.complete) {
      await new Promise<void>((resolve) => {
        let timer;
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        timer = setTimeout(done, 10000);
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
      });
    }
    const initial = {
      complete: img.complete,
      natW: img.naturalWidth,
      src: img.getAttribute("src"),
    };
    if (!initial.complete || initial.natW === 0) {
      return { err: "initial load never completed", initial };
    }
    let loadFired = false;
    let loadSeen;
    const loadTask = new Promise((resolve) => {
      loadSeen = resolve;
    });
    img.addEventListener(
      "load",
      () => {
        loadFired = true;
        loadSeen();
      },
      { once: true },
    );
    img.setAttribute("srcset", initial.src + " 1x");
    img.setAttribute("src", initial.src);
    const rightAfter = { complete: img.complete };
    await Promise.race([loadTask, new Promise((r) => setTimeout(r, 2000))]);
    return {
      initial,
      rightAfterMutation: rightAfter,
      afterTick: { complete: img.complete, natW: img.naturalWidth },
      loadFired,
    };
  });

  expect(result.err, JSON.stringify(result)).toBeUndefined();
  expect(
    result.afterTick.complete,
    "img.complete must return true after a cache-hit src/srcset re-set: " + JSON.stringify(result),
  ).toBe(true);
  expect(result.afterTick.natW).toBeGreaterThan(0);
  expect(result.loadFired, "cache-hit re-set must fire a load event").toBe(true);
});

test("img-srcset-terminal-broken-completes", async ({ page }) => {
  const FIXTURE_URL =
    process.env.KITESURF_FIXTURE ?? "http://127.0.0.1:8787/__fixtures/image-heavy.html";

  await page.goto(FIXTURE_URL, { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const cases = {
      noCandidate: ", ,",
      unfetchableScheme: "ftp://example.invalid/x.png 1x",
    };
    const out = {};
    for (const [name, srcset] of Object.entries(cases)) {
      const img = document.createElement("img");
      document.body.appendChild(img);
      const events = [];
      img.addEventListener("load", () => events.push("load"));
      img.addEventListener("error", () => events.push("error"));
      img.setAttribute("srcset", srcset);
      if (name === "noCandidate") {
        await new Promise((resolve) => setTimeout(resolve, 300));
      } else {
        await new Promise<void>((resolve) => {
          let timer;
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          timer = setTimeout(done, 3000);
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", done, { once: true });
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      out[name] = { complete: img.complete, natW: img.naturalWidth, events };
    }
    return out;
  });

  for (const name of ["noCandidate", "unfetchableScheme"]) {
    expect(
      result[name].complete,
      `${name}: complete must reach true (terminal), got ${JSON.stringify(result)}`,
    ).toBe(true);
    expect(result[name].events, `${name}: a broken image request must fire error`).toEqual([
      "error",
    ]);
    expect(result[name].natW).toBe(0);
  }
});
