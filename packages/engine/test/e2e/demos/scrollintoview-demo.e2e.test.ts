// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";

test("scrollintoview-demo", async ({ page }) => {
  await page.goto(
    "data:text/html,<!doctype html><html><body style='margin:0'>" +
      "<div id='top' style='height:50px;background:blue'>top</div>" +
      "<div style='height:3000px'></div>" +
      "<div id='target' style='height:100px;background:red'>target</div>" +
      "<div style='height:3000px'></div>" +
      "</body></html>",
    { waitUntil: "load" },
  );

  const r = await page.evaluate(async () => {
    const out: {
      hasMethod?: boolean;
      afterDefault?: number;
      afterTrue?: number;
      afterFalse?: number;
      afterStart?: number;
      afterCenter?: number;
      afterEnd?: number;
      nearestNoMove?: boolean;
      nearestFromAbove?: number;
      afterSmooth?: number;
      scrollTopType?: string;
      scrollLeftType?: string;
      scrollWidthType?: string;
      scrollHeightType?: string;
      scrollHeightPositive?: boolean;
      events?: string[];
    } = {};
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const target = document.getElementById("target");
    const evs = [];
    window.addEventListener("scroll", (e) => evs.push("win:" + e.type + "(" + e.isTrusted + ")"));
    document.addEventListener("scroll", (e) => evs.push("doc:" + e.type + "(" + e.isTrusted + ")"));
    window.addEventListener("scrollend", (e) => evs.push("win:" + e.type));
    document.addEventListener("scrollend", (e) => evs.push("doc:" + e.type));

    out.hasMethod = typeof target.scrollIntoView === "function";

    window.scrollTo(0, 0);
    target.scrollIntoView();
    out.afterDefault = window.scrollY;
    window.scrollTo(0, 0);
    target.scrollIntoView(true);
    out.afterTrue = window.scrollY;
    window.scrollTo(0, 0);
    target.scrollIntoView(false);
    out.afterFalse = window.scrollY;

    window.scrollTo(0, 0);
    target.scrollIntoView({ block: "start" });
    out.afterStart = window.scrollY;
    window.scrollTo(0, 0);
    target.scrollIntoView({ block: "center" });
    out.afterCenter = window.scrollY;
    window.scrollTo(0, 0);
    target.scrollIntoView({ block: "end" });
    out.afterEnd = window.scrollY;

    target.scrollIntoView({ block: "start" });
    const stayAt = window.scrollY;
    target.scrollIntoView({ block: "nearest" });
    out.nearestNoMove = window.scrollY === stayAt;

    window.scrollTo(0, 9999);
    target.scrollIntoView({ block: "nearest" });
    out.nearestFromAbove = window.scrollY;

    window.scrollTo(0, 0);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    out.afterSmooth = window.scrollY;

    out.scrollTopType = typeof target.scrollTop;
    out.scrollLeftType = typeof target.scrollLeft;
    out.scrollWidthType = typeof target.scrollWidth;
    out.scrollHeightType = typeof target.scrollHeight;
    out.scrollHeightPositive = target.scrollHeight >= 0;

    evs.length = 0;
    window.scrollTo(0, 100);
    window.scrollTo(0, 200);
    window.scrollTo(0, 300);
    await wait(200);
    out.events = evs.slice();

    return out;
  });

  console.log(`viewport innerHeight defaults to 720; target lives at y≈3050`);
  expect(r.hasMethod, "Element.prototype.scrollIntoView exists").toBeTruthy();
  expect(r.afterDefault > 0, "scrollIntoView() scrolls toward target").toBeTruthy();
  expect(r.afterDefault === r.afterTrue, "legacy boolean true === default").toBeTruthy();
  expect(r.afterTrue > r.afterFalse, "block:start scrolls further than block:end").toBeTruthy();
  expect(r.afterStart === r.afterTrue, "{block:'start'} === legacy true").toBeTruthy();
  expect(r.afterEnd === r.afterFalse, "{block:'end'} === legacy false").toBeTruthy();
  expect(
    r.afterCenter < r.afterStart && r.afterCenter > r.afterEnd,
    "{block:'center'} lands between end and start",
  ).toBeTruthy();
  expect(r.nearestNoMove, "block:'nearest' on already-visible target does not scroll").toBeTruthy();
  expect(
    r.nearestFromAbove === r.afterStart,
    "block:'nearest' from below = align top",
  ).toBeTruthy();
  expect(
    r.afterSmooth === r.afterStart,
    "behavior:'smooth' lands at the same final position (no animation in headless)",
  ).toBeTruthy();
  expect(r.scrollTopType === "number", "element.scrollTop is a number").toBeTruthy();
  expect(r.scrollLeftType === "number", "element.scrollLeft is a number").toBeTruthy();
  expect(r.scrollWidthType === "number", "element.scrollWidth is a number").toBeTruthy();
  expect(r.scrollHeightType === "number", "element.scrollHeight is a number").toBeTruthy();
  expect(r.scrollHeightPositive, "element.scrollHeight is non-negative").toBeTruthy();

  const scrollEvents = r.events.filter((e) => e.includes(":scroll("));
  const scrollendEvents = r.events.filter((e) => e.includes(":scrollend"));
  expect(scrollEvents.length, "3 scrolls × 2 listeners (doc+win) = 6 scroll events").toBe(6);
  expect(scrollendEvents.length, "1 coalesced scrollend × 2 listeners = 2 scrollend events").toBe(
    2,
  );
  expect(
    scrollEvents.every((e) => e.endsWith("(true)")),
    "scroll events are trusted (CDP / programmatic UA-initiated)",
  ).toBeTruthy();
  expect(
    r.events.includes("doc:scroll(true)"),
    "scroll fires on document (real-browser semantics)",
  ).toBeTruthy();
  expect(
    r.events.includes("win:scroll(true)"),
    "scroll fires on window (Chrome compat — bubbles=true workaround)",
  ).toBeTruthy();
  expect(r.events.includes("doc:scrollend"), "scrollend fires on document").toBeTruthy();
  expect(r.events.includes("win:scrollend"), "scrollend fires on window").toBeTruthy();
  expect(
    scrollendEvents.length < scrollEvents.length,
    "scrollend coalesces — fewer than scroll events",
  ).toBeTruthy();
});
