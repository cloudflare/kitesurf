// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession } from "@cloudflare/puppeteer";
import type { Protocol } from "devtools-protocol";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

type AXNode = Protocol.Accessibility.AXNode;

// Each control's ARIA attribute contradicts the state the platform computes, which is what makes a
// builder that pushes both show up. The expected values are Chrome 158's on this same markup.
const CONFLICTS = `<!doctype html><title>Conflicts</title>
<input id="aria-checked-true" type="checkbox" aria-checked="true" aria-label="a">
<input id="aria-checked-false" type="checkbox" checked aria-checked="false" aria-label="b">
<input id="aria-checked-mixed" type="radio" aria-checked="mixed" aria-label="c">
<button id="aria-enabled" disabled aria-disabled="false">d</button>
<input id="aria-optional" required aria-required="false" aria-label="e">
<input id="aria-writable" readonly aria-readonly="false" aria-label="f">
<details id="aria-collapsed" open aria-expanded="false"><summary>g</summary>body</details>
<h3 id="aria-level" aria-level="5">h</h3>
<input id="aria-bounds" type="range" min="0" max="100" aria-valuemin="10" aria-valuemax="90" aria-label="i">
<select aria-label="j"><option id="aria-unselected" selected aria-selected="false">A</option></select>`;

async function backendIds(cdp: CDPSession): Promise<Map<string, number>> {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const ids = new Map<string, number>();
  const walk = (node: Protocol.DOM.Node) => {
    const attrs = node.attributes ?? [];
    for (let i = 0; i + 1 < attrs.length; i += 2) {
      if (attrs[i] === "id") ids.set(attrs[i + 1] ?? "", node.backendNodeId);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return ids;
}

test("an AX node carries one entry per property, holding the computed state", async ({ page }) => {
  await setContent(page, CONFLICTS);
  const cdp = await page.createCDPSession();
  const ids = await backendIds(cdp);
  const nodes: AXNode[] = (await cdp.send("Accessibility.getFullAXTree")).nodes;
  const values = (id: string, property: string): unknown[] => {
    const node = nodes.find((n) => n.backendDOMNodeId === ids.get(id));
    if (!node) throw new Error(`no AX node for #${id}`);
    return (node.properties ?? [])
      .filter((p) => String(p.name) === property)
      .map((p) => p.value.value);
  };
  expect({
    checkedAriaTrue: values("aria-checked-true", "checked"),
    checkedAriaFalse: values("aria-checked-false", "checked"),
    checkedAriaMixed: values("aria-checked-mixed", "checked"),
    disabled: values("aria-enabled", "disabled"),
    required: values("aria-optional", "required"),
    readonly: values("aria-writable", "readonly"),
    expanded: values("aria-collapsed", "expanded"),
    level: values("aria-level", "level"),
    valuemin: values("aria-bounds", "valuemin"),
    valuemax: values("aria-bounds", "valuemax"),
    selected: values("aria-unselected", "selected"),
  }).toEqual({
    checkedAriaTrue: ["false"],
    checkedAriaFalse: ["true"],
    checkedAriaMixed: ["false"],
    disabled: [true],
    required: [true],
    readonly: [true],
    expanded: [true],
    level: [5],
    valuemin: [10],
    valuemax: [90],
    selected: [false],
  });
  await cdp.detach().catch(() => {});
}, 60_000);
