// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession } from "@cloudflare/puppeteer";

import { targetIdForSession } from "./connect";
import { expect, test } from "./harness";

async function setParagraphs(session: CDPSession, count: number): Promise<void> {
  const { frameTree } = (await session.send("Page.getFrameTree")) as {
    frameTree: { frame: { id: string } };
  };
  const html = `<main>${"<p>text</p>".repeat(count)}</main>`;
  await session.send("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
}

async function peakLiveBytes(session: CDPSession, resetPeak = false): Promise<number> {
  const targetId = await targetIdForSession(session);
  const reply: unknown = await session.send("Kitesurf.getMemoryStats", { targetId, resetPeak });
  if (typeof reply !== "object" || reply === null) throw new Error("missing memory stats");
  const bridge: unknown = Reflect.get(reply, "bridge");
  if (typeof bridge !== "object" || bridge === null) throw new Error("missing bridge stats");
  const swapAlloc: unknown = Reflect.get(bridge, "swapAlloc");
  if (typeof swapAlloc !== "object" || swapAlloc === null) throw new Error("missing swap stats");
  const peak: unknown = Reflect.get(swapAlloc, "peakLiveBytes");
  if (typeof peak !== "number" || !Number.isFinite(peak)) {
    throw new Error(`invalid swapAlloc.peakLiveBytes: ${String(peak)}`);
  }
  return peak;
}

test("Accessibility reply budget rejects whole trees before output allocation", async ({
  browser,
  page,
}) => {
  const controlSession = await page.createCDPSession();
  const overBudgetPage = await browser.newPage();
  const overBudgetSession = await overBudgetPage.createCDPSession();
  try {
    await setParagraphs(controlSession, 25_000);
    const controlBefore = await peakLiveBytes(controlSession, true);
    const control = (await controlSession.send("Accessibility.getFullAXTree")) as {
      nodes: unknown[];
    };
    const controlAfter = await peakLiveBytes(controlSession);
    expect(control.nodes.length).toBeGreaterThan(50_000);
    const controlGrowth = Math.max(0, controlAfter - controlBefore);

    await setParagraphs(overBudgetSession, 120_000);
    const overBudgetBefore = await peakLiveBytes(overBudgetSession, true);
    let rejection = "";
    try {
      await overBudgetSession.send("Accessibility.getFullAXTree");
    } catch (error) {
      rejection = String(error);
    }
    const overBudgetAfter = await peakLiveBytes(overBudgetSession);
    const overBudgetGrowth = Math.max(0, overBudgetAfter - overBudgetBefore);
    console.log(
      `accessibility budget peaks: control=${controlBefore}->${controlAfter} ` +
        `overBudget=${overBudgetBefore}->${overBudgetAfter}`,
    );
    expect(rejection).toContain("accessibility tree is 240004 nodes");
    expect(rejection).toContain("over the 25165824-byte reply budget");
    expect(rejection).toContain("Accessibility.getFullAXTree with depth");
    expect(controlGrowth).toBeGreaterThan(0);
    expect(overBudgetGrowth).toBeLessThan(controlGrowth * 0.05);
    console.log(
      `accessibility budget: controlNodes=${control.nodes.length} controlGrowth=${controlGrowth} ` +
        `overBudgetGrowth=${overBudgetGrowth} ratio=${(overBudgetGrowth / controlGrowth).toFixed(4)}`,
    );

    const { root } = (await overBudgetSession.send("DOM.getDocument", { depth: 0 })) as {
      root: { nodeId: number };
    };
    const { nodeId } = (await overBudgetSession.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "p:first-child",
    })) as { nodeId: number };
    expect(nodeId).toBeGreaterThan(0);

    const query = (await overBudgetSession.send("Accessibility.queryAXTree", {
      backendNodeId: nodeId,
      role: "paragraph",
    })) as { nodes: Array<{ backendDOMNodeId: number }> };
    expect(query.nodes.some((node) => node.backendDOMNodeId === nodeId)).toBe(true);

    const partial = (await overBudgetSession.send("Accessibility.getPartialAXTree", {
      backendNodeId: nodeId,
      fetchRelatives: false,
    })) as { nodes: Array<{ backendDOMNodeId: number }> };
    expect(partial.nodes.some((node) => node.backendDOMNodeId === nodeId)).toBe(true);

    const shallow = (await overBudgetSession.send("Accessibility.getFullAXTree", {
      depth: 2,
    })) as { nodes: unknown[] };
    expect(shallow.nodes.length).toBeGreaterThan(0);
    expect(shallow.nodes.length).toBeLessThan(10);
  } finally {
    await controlSession.detach().catch(() => {});
    await overBudgetSession.detach().catch(() => {});
    await overBudgetPage.close().catch(() => {});
  }
}, 600_000);
