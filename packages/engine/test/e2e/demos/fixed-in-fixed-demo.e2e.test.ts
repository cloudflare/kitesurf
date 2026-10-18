// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "../harness";
import { setContent } from "../set-content";

test("fixed-in-fixed-demo", async ({ page }) => {
  await setContent(
    page,
    `<style>html,body{height:100%;margin:0}</style>
     <header style="position:fixed;top:0;left:0;right:0;height:56px;background:#eee">
       <div id="sidebar" style="position:fixed;top:56px;bottom:0;left:0;width:288px;background:#ddd">
         <a id="navlink" href="/x" style="display:block;height:42px;margin-top:50px">Nav item</a>
       </div>
     </header>
     <main style="height:400px"></main>`,
  );

  const probe = await page.evaluate(() => {
    const r = (id) => {
      const b = document.getElementById(id).getBoundingClientRect();
      return {
        x: Math.round(b.x),
        y: Math.round(b.y),
        w: Math.round(b.width),
        h: Math.round(b.height),
      };
    };
    const link = document.getElementById("navlink");
    const lb = link.getBoundingClientRect();
    const hit = document.elementFromPoint(lb.x + lb.width / 2, lb.y + lb.height / 2);
    return {
      sidebar: r("sidebar"),
      link: r("navlink"),
      hitIsLink: hit === link,
      vh: window.innerHeight,
    };
  });

  expect(probe.sidebar.y, "sidebar top anchors below the header").toBe(56);
  expect(probe.sidebar.h, "sidebar stretches to the viewport bottom, not the 56px header box").toBe(
    probe.vh - 56,
  );
  expect(probe.link.h > 0 && probe.link.w > 0, "nav link lays out inside the sidebar").toBeTruthy();
  expect(probe.hitIsLink, "nav link is hit-testable at its on-screen position").toBe(true);
});
