// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession } from "@cloudflare/puppeteer";
import type { Protocol } from "devtools-protocol";

import { targetIdForSession } from "./connect";
import { expect, test } from "./harness";
import { setContent } from "./set-content";

function descend(root: Protocol.DOM.Node, ...names: string[]): Protocol.DOM.Node | undefined {
  let node: Protocol.DOM.Node | undefined = root;
  for (const name of names) {
    node = node?.children?.find((child) => child.nodeName === name);
  }
  return node;
}

type MemoryStats = {
  wasmBytes: number;
  swapAlloc: { peakLiveBytes: number };
};

async function memoryStats(session: CDPSession, targetId: string): Promise<MemoryStats> {
  const reply = await session.send("Kitesurf.getMemoryStats", { targetId });
  const swapAlloc = reply.bridge?.swapAlloc;
  if (!swapAlloc || typeof reply.wasmBytes !== "number") {
    throw new Error("missing allocator statistics");
  }
  return { wasmBytes: reply.wasmBytes, swapAlloc };
}

test(
  "large subtree requests fail before allocating a snapshot",
  { timeout: 300_000 },
  async ({ page }) => {
    await setContent(
      page,
      "<main style='display:none'></main><section style='display:none'></section>",
    );
    await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) throw new Error("missing main");
      main.innerHTML = "<i>x</i>".repeat(180_000);
      const section = document.querySelector("section");
      if (!section) throw new Error("missing section");
      section.innerHTML = "<i>x</i>".repeat(25_000);
    });
    const session = await page.createCDPSession();
    try {
      const targetId = await targetIdForSession(session);
      const { root } = await session.send("DOM.getDocument", { depth: 3 });
      const main = descend(root, "HTML", "BODY", "MAIN");
      const section = descend(root, "HTML", "BODY", "SECTION");
      if (!main || !section) throw new Error("missing subtree nodes");
      const before = await memoryStats(session, targetId);

      for (const method of ["DOM.getDocument", "DOM.getFlattenedDocument"] as const) {
        await expect(session.send(method, { depth: -1 })).rejects.toThrow(
          new RegExp(
            `${method.replace(".", "\\.")}.*nodes.*bytes.*budget.*DOM\\.requestChildNodes`,
          ),
        );
      }

      await expect(
        session.send("DOM.requestChildNodes", { nodeId: main.nodeId, depth: 1 }),
      ).rejects.toThrow(/DOM\.requestChildNodes.*nodes.*bytes.*budget.*DOM\.requestChildNodes/);

      const after = await memoryStats(session, targetId);
      expect(after.wasmBytes - before.wasmBytes).toBeLessThan(1024 * 1024);
      await session.send("DOM.requestChildNodes", { nodeId: section.nodeId, depth: -1 });
      const positive = await memoryStats(session, targetId);
      const rejectedDelta = after.swapAlloc.peakLiveBytes - before.swapAlloc.peakLiveBytes;
      const positiveDelta = positive.swapAlloc.peakLiveBytes - after.swapAlloc.peakLiveBytes;
      expect(positiveDelta).toBeGreaterThan(0);
      expect(rejectedDelta).toBeLessThan(positiveDelta * 0.05);
      // The accessibility tree no longer reads a DOM snapshot, and this page's large
      // subtrees are hidden, so it stays small (its own budget: accessibility-budget).
      const { nodes } = await session.send("Accessibility.getFullAXTree");
      expect(nodes.length).toBeLessThan(100);
    } finally {
      await session.detach();
    }
  },
);

test(
  "a 50,000-node whole-tree request returns all nodes",
  { timeout: 180_000 },
  async ({ page, cdpSession }) => {
    await setContent(page, "<main></main>");
    await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) throw new Error("missing main");
      main.innerHTML = "<i>x</i>".repeat(25_000);
    });
    const { root } = await cdpSession.send("DOM.getDocument", { depth: -1 });
    const main = descend(root, "HTML", "BODY", "MAIN");
    expect(main?.children).toHaveLength(25_000);
    expect(main?.children?.every((node) => node.children?.[0]?.nodeValue === "x")).toBe(true);
  },
);

test("a small whole-tree request still returns all nodes", async ({ page, cdpSession }) => {
  await setContent(page, `<main>${"<i>text</i>".repeat(100)}</main>`);
  const { root } = await cdpSession.send("DOM.getDocument", { depth: -1 });
  const main = descend(root, "HTML", "BODY", "MAIN");
  expect(main?.children).toHaveLength(100);
  expect(main?.children?.every((node) => node.children?.[0]?.nodeValue === "text")).toBe(true);
});

test(
  "a non-Latin-1 document just below the transport limit succeeds",
  { timeout: 300_000 },
  async ({ page, cdpSession }) => {
    await setContent(page, "<main style='display:none'></main><section></section>");
    await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) throw new Error("missing main");
      main.textContent = "漢".repeat(16_770_000);
      const section = document.querySelector("section");
      if (!section) throw new Error("missing section");
      section.innerHTML = "<i><b>fresh</b></i>";
    });
    const { root } = await cdpSession.send("DOM.getDocument", { depth: -1 });
    const main = descend(root, "HTML", "BODY", "MAIN");
    expect(main?.children?.[0]?.nodeValue.length).toBe(16_770_000);
    expect(main?.children?.[0]?.nodeValue.slice(0, 2)).toBe("漢漢");
    const section = descend(root, "HTML", "BODY", "SECTION");
    expect(section?.children?.[0]?.children?.[0]?.children?.[0]?.nodeValue).toBe("fresh");
  },
);

test(
  "a non-Latin-1 document above the transport limit gets a budget error",
  { timeout: 300_000 },
  async ({ page, cdpSession }) => {
    await setContent(page, "<main style='display:none'></main><section></section>");
    await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) throw new Error("missing main");
      main.textContent = "漢".repeat(16_780_000);
      const section = document.querySelector("section");
      if (!section) throw new Error("missing section");
      section.innerHTML = "<i><b>fresh</b></i>";
    });
    await expect(cdpSession.send("DOM.getDocument", { depth: -1 })).rejects.toThrow(
      /DOM\.getDocument.*nodes.*bytes.*budget.*DOM\.requestChildNodes/,
    );
  },
);

test(
  "DOM.describeNode without depth describes a node with an oversized text child",
  { timeout: 300_000 },
  async ({ page, cdpSession }) => {
    await setContent(page, "<main style='display:none'></main>");
    const { root } = await cdpSession.send("DOM.getDocument", { depth: 3 });
    const main = descend(root, "HTML", "BODY", "MAIN");
    if (!main) throw new Error("missing main");
    await page.evaluate(() => {
      const element = document.querySelector("main");
      if (!element) throw new Error("missing main");
      element.textContent = "x".repeat(33_551_000);
    });
    const { node } = await cdpSession.send("DOM.describeNode", { nodeId: main.nodeId });
    expect(node.nodeName).toBe("MAIN");
    expect(node.children).toBeUndefined();
  },
);

test(
  "a large inserted node still emits childNodeInserted",
  { timeout: 300_000 },
  async ({ page, cdpSession }) => {
    await setContent(page, "<main></main><aside><i></i></aside>");
    await page.evaluate(() => {
      const node = document.querySelector("i");
      if (!node) throw new Error("missing node");
      node.setAttribute("title", "x".repeat(33_551_000));
    });
    await cdpSession.send("DOM.enable");
    const { root } = await cdpSession.send("DOM.getDocument", { depth: 3 });
    const main = descend(root, "HTML", "BODY", "MAIN");
    if (!main) throw new Error("missing main node");
    await cdpSession.send("DOM.requestChildNodes", { nodeId: main.nodeId, depth: 1 });
    const inserted: Array<{ id: number; length: number }> = [];
    cdpSession.on("DOM.childNodeInserted", (event) => {
      if (event.node.nodeName === "I") {
        inserted.push({ id: event.node.nodeId, length: event.node.attributes?.[1]?.length ?? 0 });
      }
    });
    await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) throw new Error("missing main");
      const node = document.querySelector("i");
      if (!node) throw new Error("missing node");
      main.appendChild(node);
    });
    await expect
      .poll(() => inserted.map((node) => node.length), { timeout: 10_000 })
      .toEqual([33_551_000]);
    const node = inserted[0];
    if (!node) throw new Error("missing inserted node");
    await expect(
      cdpSession.send("DOM.describeNode", { nodeId: node.id, depth: -1 }),
    ).rejects.toThrow(/DOM\.describeNode.*nodes.*bytes.*budget.*DOM\.requestChildNodes/);
    const described = await cdpSession.send("DOM.describeNode", { nodeId: main.nodeId, depth: -1 });
    expect(described.node.nodeName).toBe("MAIN");
  },
);
