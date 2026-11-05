// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { targetIdForSession } from "./connect";
import { expect, test } from "./harness";
import { setContent } from "./set-content";

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
      const body = root.children?.[0]?.children?.find((node) => node.nodeName === "BODY");
      const main = body?.children?.find((node) => node.nodeName === "MAIN");
      const section = body?.children?.find((node) => node.nodeName === "SECTION");
      if (!main || !section) throw new Error("missing subtree nodes");
      const before = await session.send("Kitesurf.getMemoryStats", { targetId });
      if (!before.bridge?.swapAlloc || typeof before.wasmBytes !== "number") {
        throw new Error("missing allocator statistics");
      }

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

      const after = await session.send("Kitesurf.getMemoryStats", { targetId });
      if (!after.bridge?.swapAlloc || typeof after.wasmBytes !== "number") {
        throw new Error("missing allocator statistics");
      }
      expect(after.wasmBytes - before.wasmBytes).toBeLessThan(1024 * 1024);
      await session.send("DOM.requestChildNodes", { nodeId: section.nodeId, depth: -1 });
      const positive = await session.send("Kitesurf.getMemoryStats", { targetId });
      if (!positive.bridge?.swapAlloc) throw new Error("missing positive-control statistics");
      const rejectedDelta =
        after.bridge.swapAlloc.peakLiveBytes - before.bridge.swapAlloc.peakLiveBytes;
      const positiveDelta =
        positive.bridge.swapAlloc.peakLiveBytes - after.bridge.swapAlloc.peakLiveBytes;
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
    const html = root.children?.find((node) => node.nodeName === "HTML");
    const body = html?.children?.find((node) => node.nodeName === "BODY");
    const main = body?.children?.find((node) => node.nodeName === "MAIN");
    expect(main?.children).toHaveLength(25_000);
    expect(main?.children?.every((node) => node.children?.[0]?.nodeValue === "x")).toBe(true);
  },
);

test("a small whole-tree request still returns all nodes", async ({ page, cdpSession }) => {
  await setContent(page, `<main>${"<i>text</i>".repeat(100)}</main>`);
  const { root } = await cdpSession.send("DOM.getDocument", { depth: -1 });
  const html = root.children?.find((node) => node.nodeName === "HTML");
  const body = html?.children?.find((node) => node.nodeName === "BODY");
  const main = body?.children?.find((node) => node.nodeName === "MAIN");
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
    const main = root.children
      ?.find((n) => n.nodeName === "HTML")
      ?.children?.find((n) => n.nodeName === "BODY")
      ?.children?.find((n) => n.nodeName === "MAIN");
    expect(main?.children?.[0]?.nodeValue.length).toBe(16_770_000);
    expect(main?.children?.[0]?.nodeValue.slice(0, 2)).toBe("漢漢");
    const section = root.children
      ?.find((n) => n.nodeName === "HTML")
      ?.children?.find((n) => n.nodeName === "BODY")
      ?.children?.find((n) => n.nodeName === "SECTION");
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
    const main = root.children
      ?.find((n) => n.nodeName === "HTML")
      ?.children?.find((n) => n.nodeName === "BODY")
      ?.children?.find((n) => n.nodeName === "MAIN");
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
    const main = root.children
      ?.find((n) => n.nodeName === "HTML")
      ?.children?.find((n) => n.nodeName === "BODY")
      ?.children?.find((n) => n.nodeName === "MAIN");
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
