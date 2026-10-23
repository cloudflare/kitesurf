// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { Page } from "@cloudflare/puppeteer";

import { targetIdForSession } from "./connect";
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const TREE_COUNT = 40;
const PRESSURE_ROUNDS = 200;
const SETTLE_MS = 100;
const SWEEP_SETTLE_MS = 1500;
const PRESSURE_OBJECTS = 300_000;
const RETAINED_PRESSURE_BATCHES = 3;
const NODE_SLACK = 10;
const PAGE = `<main></main><script>
  const host = document.querySelector("main");
  globalThis.churnOwnedCache = (kind) => {
    for (let i = 0; i < ${TREE_COUNT}; i++) {
      const root = document.createElement("section");
      const child = document.createElement(kind === "sheet" ? "style" : kind === "track" ? "track" : "i");
      root.appendChild(child);
      host.appendChild(root);
      if (kind === "sheet") {
        child.textContent = ".test { color: red; }";
        void child.sheet.cssRules.length;
      } else if (kind === "track") {
        child.track.mode = "showing";
      } else {
        child.setAttribute("data-token", "kept");
        void child.getAttributeNode("data-token");
      }
      root.remove();
    }
  };
  globalThis.pressureKeep = [];
  globalThis.pressureOwnedCache = () => {
    const a = [];
    for (let i = 0; i < ${PRESSURE_OBJECTS}; i++) a.push({ x: i, y: [i] });
    pressureKeep.push(a);
    if (pressureKeep.length > ${RETAINED_PRESSURE_BATCHES}) pressureKeep.shift();
  };
  globalThis.setupConnectedCaches = () => {
    const main = document.querySelector("main");
    main.setAttribute("data-state", "before");
    main.getAttributeNode("data-state").marker = "kept";
    const style = document.createElement("style");
    style.textContent = ".test { color: red; }";
    const track = document.createElement("track");
    main.append(style, track);
    style.sheet.disabled = true;
    track.track.mode = "showing";
  };
</script>`;

async function nodeCount(page: Page): Promise<number> {
  const session = await page.createCDPSession();
  try {
    const targetId = await targetIdForSession(session);
    const stats = await session.send("Kitesurf.getMemoryStats", { targetId });
    if (typeof stats.domNodes !== "number") throw new Error("missing DOM node count");
    return stats.domNodes;
  } finally {
    await session.detach();
  }
}

async function applyPressure(page: Page): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  await page.evaluate(() => {
    const pressure: unknown = Reflect.get(globalThis, "pressureOwnedCache");
    if (typeof pressure !== "function") throw new Error("missing pressure function");
    pressure();
  });
}

for (const kind of ["attr", "sheet", "track"] as const) {
  test(
    `dropped ${kind} objects do not root their detached trees`,
    { timeout: 90_000 },
    async ({ page }) => {
      await setContent(page, PAGE);
      const before = await nodeCount(page);
      await page.evaluate((kind) => {
        const churn: unknown = Reflect.get(globalThis, "churnOwnedCache");
        if (typeof churn !== "function") throw new Error("missing churn function");
        churn(kind);
      }, kind);
      let remaining = await nodeCount(page);
      expect(remaining).toBeGreaterThan(before + TREE_COUNT);
      for (let round = 0; round < PRESSURE_ROUNDS && remaining > before + NODE_SLACK; round++) {
        await applyPressure(page);
        remaining = await nodeCount(page);
      }
      expect(remaining, `retained nodes after dropping ${kind} objects`).toBeLessThanOrEqual(
        before + NODE_SLACK,
      );
    },
  );
}

test("held node-owned objects preserve identity, state, and owner after a sweep", async ({
  page,
}) => {
  await setContent(
    page,
    `<main></main><script>
    const root = document.createElement("section");
    const owner = document.createElement("i");
    owner.setAttribute("data-token", "before");
    const style = document.createElement("style");
    style.textContent = ".test { color: red; }";
    const track = document.createElement("track");
    root.append(owner, style, track);
    document.querySelector("main").appendChild(root);
    globalThis.heldObjects = {
      attr: owner.getAttributeNode("data-token"),
      sheet: style.sheet,
      track: track.track,
    };
    heldObjects.track.mode = "showing";
    root.remove();
  </script>`,
  );
  await new Promise((resolve) => setTimeout(resolve, SWEEP_SETTLE_MS));
  const result = await page.evaluate(() => {
    const held: unknown = Reflect.get(globalThis, "heldObjects");
    const requireObject = (value: unknown, message: string): object => {
      if (typeof value !== "object" || value === null) throw new Error(message);
      return value;
    };
    const readHeldObjects = (value: object) => {
      const attr: unknown = Reflect.get(value, "attr");
      const sheet: unknown = Reflect.get(value, "sheet");
      const track: unknown = Reflect.get(value, "track");
      if (
        !(attr instanceof Attr) ||
        !(sheet instanceof CSSStyleSheet) ||
        typeof track !== "object" ||
        track === null
      ) {
        throw new Error("invalid held objects");
      }
      return { attr, sheet, track };
    };
    const resolveOwners = (attr: Attr, sheet: CSSStyleSheet) => {
      const owner = attr.ownerElement;
      const style = sheet.ownerNode;
      if (!owner || !(style instanceof HTMLStyleElement)) throw new Error("missing owners");
      const root = owner.parentElement;
      if (!root) throw new Error("missing detached tree");
      const trackOwner = root.querySelector("track");
      if (!trackOwner) throw new Error("missing track owner");
      return { owner, style, root, trackOwner };
    };
    const objects = readHeldObjects(requireObject(held, "missing held objects"));
    const { attr, sheet, track } = objects;
    const { owner, style, root, trackOwner } = resolveOwners(attr, sheet);
    attr.value = "after";
    document.body.appendChild(root);
    return {
      attr: owner.getAttributeNode("data-token") === attr,
      value: owner.getAttribute("data-token"),
      sheet: style.sheet === sheet,
      rule: sheet.cssRules[0]?.cssText,
      track: trackOwner.track === track,
      mode: Reflect.get(track, "mode"),
      connected: root.isConnected,
    };
  });
  expect(result).toEqual({
    attr: true,
    value: "after",
    sheet: true,
    rule: ".test { color: red; }",
    track: true,
    mode: "showing",
    connected: true,
  });
});

test("connected owners preserve cache state even when the values are not held", async ({
  page,
}) => {
  await setContent(page, PAGE);
  await page.evaluate(() => {
    const setup: unknown = Reflect.get(globalThis, "setupConnectedCaches");
    if (typeof setup !== "function") throw new Error("missing cache setup");
    setup();
  });
  for (let round = 0; round < PRESSURE_ROUNDS; round++) await applyPressure(page);
  const result = await page.evaluate(() => {
    const attributeFor = (main: Element | null) => main?.getAttributeNode("data-state");
    const sheetFor = (main: Element | null) => main?.querySelector("style")?.sheet;
    const trackFor = (main: Element | null) => main?.querySelector("track")?.track;
    const requireConnectedCaches = (
      attr: Attr | null | undefined,
      sheet: CSSStyleSheet | null | undefined,
      track: TextTrack | null | undefined,
    ) => {
      if (!attr || !sheet || !track) throw new Error("missing connected objects");
      return { attr, sheet, track };
    };
    const main = document.querySelector("main");
    const { attr, sheet, track } = requireConnectedCaches(
      attributeFor(main),
      sheetFor(main),
      trackFor(main),
    );
    return { attr: Reflect.get(attr, "marker"), disabled: sheet.disabled, mode: track.mode };
  });
  expect(result).toEqual({ attr: "kept", disabled: true, mode: "showing" });
});
