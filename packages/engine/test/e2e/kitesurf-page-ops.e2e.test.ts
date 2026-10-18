// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Kitesurf.getPageState, setControlValue and the paint-damage pair, driven over CDP.

import type { CDPSession } from "@cloudflare/puppeteer";
import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { targetIdForSession } from "./connect";

async function nodeIdOf(session: CDPSession, selector: string): Promise<number> {
  const { root } = await session.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`no node for ${selector}`);
  return nodeId;
}

test("getPageState reports the URL, title and a mutation counter that moves", async ({ page }) => {
  await setContent(page, "<title>State</title><p id=p>a</p>");
  const session = await page.createCDPSession();
  const targetId = await targetIdForSession(session);
  const before = await session.send("Kitesurf.getPageState", { targetId });
  expect(before.error).toBeUndefined();
  expect(before.title).toBe("State");
  expect(before.href).toMatch(/^data:text\/html/);
  expect(before.scrollY).toBe(0);
  await page.evaluate(() => {
    document.getElementById("p")?.append("b");
  });
  const after = await session.send("Kitesurf.getPageState", { targetId });
  expect(typeof before.seq).toBe("number");
  expect(after.seq).toBeGreaterThan(before.seq ?? Infinity);
  await session.detach().catch(() => {});
});

test("setControlValue writes like a user and refuses controls a user can't set", async ({
  page,
}) => {
  await setContent(
    page,
    `<input id=t><input id=ro readonly value=keep><input id=off disabled>
    <select id=s><option value=a>A<option value=b>B<option value=c disabled>C</select>
    <script>
      window.events = [];
      for (const id of ["t", "s"]) {
        const el = document.getElementById(id);
        el.addEventListener("input", (e) => events.push(id + ":input:" + e.isTrusted));
        el.addEventListener("change", (e) => events.push(id + ":change:" + e.isTrusted));
      }
    </script>`,
  );
  const session = await page.createCDPSession();
  const targetId = await targetIdForSession(session);
  const set = (selector: string, value: unknown) =>
    nodeIdOf(session, selector).then((nodeId) =>
      session.send("Kitesurf.setControlValue", { targetId, nodeId, value }),
    );

  expect(await set("#t", "hello")).toEqual({ changed: true, value: "hello" });
  expect(await set("#s", "b")).toMatchObject({ changed: true, value: "b" });
  expect(await page.evaluate(() => Reflect.get(window, "events"))).toEqual([
    "t:input:true",
    "t:change:true",
    "s:input:true",
    "s:change:true",
  ]);

  expect(await set("#ro", "x")).toMatchObject({ changed: false, error: "control is read-only" });
  expect(await set("#off", "x")).toMatchObject({ changed: false, error: "control is disabled" });
  expect(await set("#s", "c")).toMatchObject({ changed: false, error: "no such option" });
  expect(await set("p, body", "x")).toMatchObject({ changed: false });
  expect(
    await session.send("Kitesurf.setControlValue", { targetId, nodeId: -1, value: "x" }),
  ).toEqual({ changed: false, error: "bad nodeId" });
  await session.detach().catch(() => {});
});

test("getPaintDamageSince reports nodes repainted after markPaintDamage", async ({ page }) => {
  await setContent(
    page,
    `<style>.on { background: rgb(200, 0, 0) }</style>
    <div id=box style="width:40px;height:40px">x</div><div id=still>y</div>`,
  );
  const session = await page.createCDPSession();
  const targetId = await targetIdForSession(session);
  await page.screenshot();
  expect(await session.send("Kitesurf.markPaintDamage", { targetId })).toEqual({});
  await page.evaluate(() => document.getElementById("box")?.classList.add("on"));
  await page.screenshot();
  const box = await nodeIdOf(session, "#box");
  const still = await nodeIdOf(session, "#still");
  const damage = await session.send("Kitesurf.getPaintDamageSince", { targetId });
  expect(damage.error).toBeUndefined();
  expect(damage.nodeIds).toContain(box);
  expect(damage.nodeIds).not.toContain(still);

  // Excluding the node a client acted on drops it and its ancestors from the next report.
  await session.send("Kitesurf.markPaintDamage", { targetId });
  await page.evaluate(() => document.getElementById("box")?.classList.remove("on"));
  await page.screenshot();
  const excluded = await session.send("Kitesurf.getPaintDamageSince", {
    targetId,
    excludeNodeId: box,
  });
  expect(excluded.nodeIds).not.toContain(box);
  await session.detach().catch(() => {});
});
