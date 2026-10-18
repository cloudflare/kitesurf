// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession } from "@cloudflare/puppeteer";
import type { Protocol } from "devtools-protocol";

import { expect, test } from "./harness";
import { setContent } from "./set-content";
import { PAGE } from "./accessibility-live-select-page";

type AXNode = Protocol.Accessibility.AXNode;

async function tree(cdp: CDPSession): Promise<AXNode[]> {
  return (await cdp.send("Accessibility.getFullAXTree")).nodes;
}

function selectedOptions(nodes: AXNode[]): string[] {
  return nodes
    .filter(
      (n) =>
        !n.ignored &&
        n.role?.value === "option" &&
        n.properties?.some((p) => p.name === "selected" && p.value.value === true),
    )
    .map((n) => String(n.name?.value));
}

async function backendOf(cdp: CDPSession, selector: string): Promise<number> {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  const { node } = await cdp.send("DOM.describeNode", { nodeId });
  return node.backendNodeId;
}

function valueOf(nodes: AXNode[], backend: number): unknown {
  return nodes.find((n) => n.backendDOMNodeId === backend)?.value?.value;
}

test("option selectedness and a select's value follow live state, not the selected attribute", async ({
  page,
}) => {
  await setContent(page, PAGE);
  const cdp = await page.createCDPSession();
  const sort = await backendOf(cdp, "#s");
  const plain = await backendOf(cdp, "#p");

  let nodes = await tree(cdp);
  expect(selectedOptions(nodes).sort()).toEqual([
    "Announcement date",
    "First x",
    "Green",
    "Plain one",
  ]);
  expect(valueOf(nodes, sort)).toBe("Announcement date");
  expect(valueOf(nodes, plain)).toBe("Plain one");

  await page.evaluate(`document.getElementById("s").value = "sub"`);
  nodes = await tree(cdp);
  expect(selectedOptions(nodes)).toContain("Submission date");
  expect(selectedOptions(nodes)).not.toContain("Announcement date");
  expect(valueOf(nodes, sort)).toBe("Submission date");

  await page.evaluate(`document.getElementById("s").selectedIndex = -1`);
  nodes = await tree(cdp);
  expect(selectedOptions(nodes)).not.toContain("Submission date");
  expect(selectedOptions(nodes)).not.toContain("Announcement date");
  expect(valueOf(nodes, sort)).toBeUndefined();

  await page.evaluate(
    `document.getElementById("m").options[0].selected = true; document.getElementById("d").selectedIndex = 1`,
  );
  nodes = await tree(cdp);
  expect(selectedOptions(nodes)).toEqual(expect.arrayContaining(["Red", "Green", "Second x"]));
  expect(selectedOptions(nodes)).not.toContain("Blue");
  expect(selectedOptions(nodes)).not.toContain("First x");

  await page.evaluate(`document.getElementById("f").reset()`);
  nodes = await tree(cdp);
  expect(selectedOptions(nodes).sort()).toEqual([
    "Announcement date",
    "First x",
    "Green",
    "Plain one",
  ]);
  await cdp.detach().catch(() => {});
}, 60_000);

const HIDDEN_OPTIONS = `<!doctype html><title>Hidden</title>
  <select id="menu"><option>Menu shown</option><option style="display:none">Menu inline hidden</option><option id="later">Menu script hidden</option></select>
  <select id="grouped"><optgroup label="Kept"><option>Group shown</option></optgroup><optgroup label="Dropped" style="display:none"><option>Group hidden</option></optgroup></select>
  <select id="list" size="3"><option>List shown</option><option style="color:red; display: none !important">List hidden</option></select>
  <select id="multi" multiple><option>Multi shown</option><option style="display:none">Multi hidden</option></select>`;

function pickable(nodes: AXNode[]): string[] {
  return nodes
    .filter((n) => !n.ignored && n.role?.value === "option")
    .map((n) => String(n.name?.value));
}

test("options the author hid with display:none are not pickable, a select's others are", async ({
  page,
}) => {
  await setContent(page, HIDDEN_OPTIONS);
  await page.evaluate(`document.getElementById("later").style.display = "none"`);
  const cdp = await page.createCDPSession();
  const names = pickable(await tree(cdp));
  expect(names.sort()).toEqual(["Group shown", "List shown", "Menu shown", "Multi shown"]);
  await cdp.detach().catch(() => {});
}, 60_000);
