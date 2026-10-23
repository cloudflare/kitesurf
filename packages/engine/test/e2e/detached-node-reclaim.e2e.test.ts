// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";
import { expect } from "vitest";

import { test } from "./harness";
import { setContent } from "./set-content";
import { targetIdForSession } from "./connect";

interface Stats {
  domNodes: number;
  wrappers: { demoted: number; revived: number; reclaimed: number };
}

async function stats(page: Page): Promise<Stats> {
  const session = await page.createCDPSession();
  const targetId = await targetIdForSession(session);
  const s = await session.send("Kitesurf.getMemoryStats", { targetId });
  await session.detach().catch(() => {});
  const domNodes = s.domNodes;
  const wrappers = s.wrappers;
  const hasNumericWrapperStats = (
    value: typeof wrappers,
  ): value is Record<string, number> & {
    demoted: number;
    revived: number;
    reclaimed: number;
  } =>
    !!value &&
    typeof value.demoted === "number" &&
    typeof value.revived === "number" &&
    typeof value.reclaimed === "number";
  if (typeof domNodes !== "number" || !hasNumericWrapperStats(wrappers)) {
    throw new Error(`no stats in ${JSON.stringify(s).slice(0, 200)}`);
  }
  return {
    domNodes,
    wrappers: {
      demoted: wrappers.demoted,
      revived: wrappers.revived,
      reclaimed: wrappers.reclaimed,
    },
  };
}

const PAGE = `<div id=feed></div><script>
  const feed = document.getElementById("feed");
  globalThis.__churn = (rows) => {
    for (let i = 0; i < rows; i++) {
      const row = document.createElement("article");
      for (let j = 0; j < 10; j++) {
        const s = document.createElement("span");
        s.textContent = "post " + i + "." + j;
        s.__fiber = { i, j };
        row.appendChild(s);
      }
      feed.appendChild(row);
      if (feed.childNodes.length > 5) feed.removeChild(feed.firstChild);
    }
    return feed.childNodes.length;
  };
  globalThis.__keep = [];
  globalThis.__pressure = () => {
    const a = [];
    for (let i = 0; i < 300000; i++) a.push({ x: i, y: [i] });
    __keep.push(a);
    if (__keep.length > 3) __keep.shift();
    return a.length;
  };
</script>`;

const pressure = (page: Page) =>
  page.evaluate(() => (globalThis as typeof globalThis & { __pressure(): number }).__pressure());

async function pressureUntil(
  page: Page,
  done: (s: Stats) => boolean,
  rounds = 250,
): Promise<Stats> {
  let s = await stats(page);
  for (let i = 0; i < rounds && !done(s); i++) {
    await new Promise((r) => setTimeout(r, 100));
    await pressure(page);
    s = await stats(page);
  }
  return s;
}

test("removed subtrees nothing references are freed", { timeout: 90_000 }, async ({ page }) => {
  await setContent(page, PAGE);
  const before = (await stats(page)).domNodes;
  await page.evaluate(() =>
    (globalThis as typeof globalThis & { __churn(n: number): number }).__churn(500),
  );
  expect((await stats(page)).domNodes - before).toBeGreaterThan(10_000);
  const after = await pressureUntil(page, (s) => s.domNodes - before < 2000);
  expect(after.domNodes - before, "nodes left in the tree after GC").toBeLessThan(2000);
});

test(
  "a held detached node keeps its identity and expandos through a sweep",
  { timeout: 90_000 },
  async ({ page }) => {
    await setContent(page, PAGE);
    await page.evaluate(() => {
      const g = globalThis as typeof globalThis & { __kept?: HTMLElement; __child?: Element };
      const feed = document.getElementById("feed")!;
      const kept = document.createElement("section");
      (kept as HTMLElement & { __fiber: string }).__fiber = "root";
      kept.innerHTML = "<b>child</b>";
      const child = kept.firstChild;
      if (!child) throw new Error("missing detached child");
      (child as ChildNode & { __fiber: string }).__fiber = "child";
      feed.appendChild(kept);
      feed.removeChild(kept);
      g.__child = kept.firstChild as Element;
      return 1;
    });
    await pressureUntil(page, (s) => s.wrappers.demoted > 0);
    for (let i = 0; i < 10; i++) await pressure(page);
    await page.evaluate(() => {
      const g = globalThis as typeof globalThis & { __child?: Element };
      document.getElementById("feed")!.appendChild(g.__child!.parentNode!);
      g.__child = undefined;
      return 1;
    });
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 50));
      await pressure(page);
    }
    const got = await page.evaluate(() => {
      const root = document.getElementById("feed")!.lastChild;
      const child = root?.firstChild;
      if (!root || !child) throw new Error("missing reclaimed nodes");
      return [
        (root as ChildNode & { __fiber?: string }).__fiber,
        (child as ChildNode & { __fiber?: string }).__fiber,
      ];
    });
    expect(got).toEqual(["root", "child"]);
    expect((await stats(page)).wrappers.revived).toBeGreaterThanOrEqual(2);
  },
);

test(
  "a connected node keeps its expandos after the page drops its wrapper",
  { timeout: 60_000 },
  async ({ page }) => {
    await setContent(page, PAGE);
    await page.evaluate(() => {
      const feed = document.getElementById("feed")!;
      const el = document.createElement("div");
      (el as HTMLDivElement & { __fiber: string }).__fiber = "connected";
      feed.appendChild(el);
      const moved = document.createElement("p");
      (moved as HTMLParagraphElement & { __fiber: string }).__fiber = "moved";
      feed.appendChild(moved);
      feed.removeChild(moved);
      feed.appendChild(moved);
      return 1;
    });
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 50));
      await pressure(page);
    }
    const got = await page.evaluate(() =>
      [...document.getElementById("feed")!.children].map(
        (c) => (c as Element & { __fiber?: string }).__fiber ?? null,
      ),
    );
    expect(got).toEqual(["connected", "moved"]);
  },
);

test(
  "an unreferenced new Image() still fires its load event",
  { timeout: 90_000 },
  async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto("https://ks.invalid/__fixtures/xhr-boot.html", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.evaluate(`(() => {
    globalThis.__loaded = 0;
    globalThis.__keep = [];
    globalThis.__pressure = () => {
      const a = [];
      for (let i = 0; i < 300000; i++) a.push({ x: i, y: [i] });
      __keep.push(a);
      if (__keep.length > 3) __keep.shift();
      return a.length;
    };
    for (let i = 0; i < 5; i++) {
      const img = new Image();
      img.onload = () => { globalThis.__loaded++; };
      img.src = "/__fixtures/slow-headers-red.png?ms=4000&i=" + i;
    }
    // A child-list change, so the sweep runs while the images load.
    document.body.appendChild(document.createElement("i")).remove();
    return 1;
  })()`);
    let loaded = 0;
    for (let i = 0; i < 120 && loaded < 5; i++) {
      await new Promise((r) => setTimeout(r, 100));
      await page.evaluate("__pressure()");
      loaded = (await page.evaluate("__loaded")) as number;
    }
    expect(loaded).toBe(5);
  },
);

test(
  "a removed node with a listener that closes over it is freed",
  { timeout: 90_000 },
  async ({ page }) => {
    await setContent(
      page,
      PAGE +
        `<script>
    globalThis.__listenerChurn = () => {
      for (let i = 0; i < 300; i++) {
        const row = document.createElement("div");
        row.innerHTML = "<span>a</span><span>b</span>";
        row.addEventListener("click", () => row.classList.toggle("on"));
        feed.appendChild(row);
        feed.removeChild(row);
      }
      return 1;
    };
  </script>`,
    );
    const before = (await stats(page)).domNodes;
    await page.evaluate("__listenerChurn()");
    const after = await pressureUntil(page, (s) => s.domNodes - before < 300);
    expect(after.domNodes - before, "nodes left in the tree after GC").toBeLessThan(300);
  },
);

test("dropping a replaced ID owner keeps the bare global of its connected successor", async ({
  page,
}) => {
  // Neither original is ever wrapped, so textContent drops them and forgets their IDs. A deep
  // clone takes one ID through insertion and a created node takes the other through `id`.
  await setContent(
    page,
    `<div id="cloneHost"><p id="remounted">clone</p></div><div id="host"><p id="app">old</p></div><script>
    const cloneHost = document.getElementById("cloneHost");
    document.body.appendChild(cloneHost.cloneNode(true));
    cloneHost.textContent = "";
    const host = document.getElementById("host");
    host.textContent = "";
    const next = document.createElement("p");
    next.id = "app";
    next.textContent = "new";
    host.appendChild(next);
    globalThis.remountResult = [
      typeof remounted === "undefined" ? null : remounted.textContent,
      typeof app === "undefined" ? null : app.textContent,
    ];
  </script>`,
  );
  expect(await page.evaluate(() => Reflect.get(globalThis, "remountResult"))).toEqual([
    "clone",
    "new",
  ]);
});
