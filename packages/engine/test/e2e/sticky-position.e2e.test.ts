// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import stickyHtml from "./html/sticky.html?raw";

test("position:sticky pins against its scrollport", async ({ page }) => {
  await page.setViewport({ width: 800, height: 600 });
  await setContent(page, stickyHtml, { waitUntil: "domcontentloaded" });

  const measure = () =>
    page.evaluate(() => {
      const mustGet = (id: string): HTMLElement => {
        const el = document.getElementById(id);
        if (!el) throw new Error(`missing element #${id}`);
        return el;
      };
      const y = (id: string) => Math.round(mustGet(id).getBoundingClientRect().y);
      const port = mustGet("port");
      const cb = mustGet("cb");
      const out: Record<string, number> = {};
      out.rest = y("pinned");
      port.scrollTop = 60;
      out.pinned = y("pinned");
      port.scrollTop = 0;
      out.restAgain = y("pinned");
      cb.scrollTop = 200;
      out.clamped = y("clamped") - y("cb");
      cb.scrollTop = 0;
      window.scrollTo(0, 300);
      out.pageScrolled = y("page");
      window.scrollTo(0, 0);
      out.pageRest = y("page");
      return out;
    });

  expect(await measure()).toEqual({
    rest: 50,
    pinned: 20,
    restAgain: 50,
    clamped: 0,
    pageScrolled: 120,
    pageRest: 420,
  });

  const hit = await page.evaluate(() => {
    const mustGet = (id: string): HTMLElement => {
      const el = document.getElementById(id);
      if (!el) throw new Error(`missing element #${id}`);
      return el;
    };
    const port = mustGet("port");
    port.scrollTop = 60;
    const el = document.elementFromPoint(40, 30);
    port.scrollTop = 0;
    return el?.id ?? "none";
  });
  expect(hit).toBe("pinned");
}, 120_000);

test("sticky pins on both axes, nests, and follows the root scroller", async ({ page }) => {
  await page.setViewport({ width: 800, height: 600 });
  await setContent(page, stickyHtml, { waitUntil: "domcontentloaded" });

  expect(
    await page.evaluate(() => {
      const mustGet = (id: string): HTMLElement => {
        const el = document.getElementById(id);
        if (!el) throw new Error(`missing element #${id}`);
        return el;
      };
      const relX = (id: string, port: string) =>
        Math.round(mustGet(id).getBoundingClientRect().x - mustGet(port).getBoundingClientRect().x);
      const relY = (id: string, port: string) =>
        Math.round(mustGet(id).getBoundingClientRect().y - mustGet(port).getBoundingClientRect().y);
      const out: Record<string, unknown> = {};

      out.hRest = relX("hpin", "hport");
      mustGet("hport").scrollLeft = 100;
      out.hPinned = relX("hpin", "hport");
      mustGet("hport").scrollLeft = 0;

      mustGet("ibport").scrollTop = 50;
      out.ibScrollTop = mustGet("ibport").scrollTop;
      out.ibScrollHeight = mustGet("ibport").scrollHeight;

      out.nRest = [relY("nouter", "nport"), relY("ninner", "nport")];
      mustGet("nport").scrollTop = 100;
      out.nPinned = [relY("nouter", "nport"), relY("ninner", "nport")];
      mustGet("nport").scrollTop = 0;

      window.scrollTo(0, 500);
      out.pagePinned = Math.round(mustGet("page").getBoundingClientRect().y);
      window.scrollTo(0, 0);
      return out;
    }),
  ).toEqual({
    hRest: 70,
    hPinned: 10,
    ibScrollTop: 50,
    ibScrollHeight: 400,
    nRest: [60, 60],
    nPinned: [10, 30],
    pagePinned: 40,
  });

  expect(
    await page.evaluate(() => {
      const mustGet = (id: string): HTMLElement => {
        const el = document.getElementById(id);
        if (!el) throw new Error(`missing element #${id}`);
        return el;
      };
      const sport = mustGet("sport");
      const siv = mustGet("siv");
      const rest = Math.round(siv.getBoundingClientRect().y - sport.getBoundingClientRect().y);
      siv.scrollIntoView();
      return { rest, scrolledTo: sport.scrollTop };
    }),
  ).toEqual({ rest: 170, scrolledTo: 300 });
}, 120_000);

test.for([
  ["html", "sticky-root-overflow"],
  ["body", "sticky-body-overflow"],
] as const)(
  "root-scroller sticky survives overflow on <%s>",
  { timeout: 120_000 },
  async ([_el, fixture], { page }) => {
    await page.setViewport({ width: 800, height: 600 });
    await page.goto(`https://ks.invalid/__fixtures/${fixture}.html`, {
      waitUntil: "domcontentloaded",
    });

    expect(
      await page.evaluate(() => {
        const mustGet = (id: string): HTMLElement => {
          const el = document.getElementById(id);
          if (!el) throw new Error(`missing element #${id}`);
          return el;
        };
        const y = () => Math.round(mustGet("head").getBoundingClientRect().y);
        const out: Record<string, number> = { rest: y() };
        window.scrollTo(0, 300);
        out.pinned = y();
        window.scrollTo(0, 0);
        out.restAgain = y();
        return out;
      }),
    ).toEqual({ rest: 100, pinned: 25, restAgain: 100 });
  },
);

test("a percentage height under min-height grows to content", async ({ page }) => {
  await page.setViewport({ width: 800, height: 600 });
  await setContent(
    page,
    `<style>
       body { margin: 0; min-height: 100vh; font: 16px monospace; }
       #wrap { height: 100%; display: flex; flex-direction: column; }
       #head { position: sticky; top: 0; height: 50px; background: #ccf; }
     </style>
     <div id="wrap">
       <div id="head">head</div>
       <div style="height:2000px">filler</div>
     </div>`,
    { waitUntil: "domcontentloaded" },
  );

  expect(
    await page.evaluate(() => {
      const mustGet = (id: string): HTMLElement => {
        const el = document.getElementById(id);
        if (!el) throw new Error(`missing element #${id}`);
        return el;
      };
      const y = () => Math.round(mustGet("head").getBoundingClientRect().y);
      const out: Record<string, number> = {
        wrapHeight: Math.round(mustGet("wrap").getBoundingClientRect().height),
        rest: y(),
      };
      window.scrollTo(0, 800);
      out.pinned = y();
      window.scrollTo(0, 0);
      return out;
    }),
  ).toEqual({ wrapHeight: 2050, rest: 0, pinned: 0 });
}, 120_000);
