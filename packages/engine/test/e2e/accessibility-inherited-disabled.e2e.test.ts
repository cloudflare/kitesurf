// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession } from "@cloudflare/puppeteer";
import type { Protocol } from "devtools-protocol";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

// Expected values measured on Chrome 158 for this markup: a disabled fieldset also takes focus
// away, while aria-disabled and a disabled select leave their controls focusable.
const DISABLED = `<!doctype html><title>Disabled</title>
<fieldset disabled>
  <legend><button id="in-first-legend">a</button></legend>
  <legend><button id="in-second-legend">b</button></legend>
  <input id="in-fieldset" aria-label="in fieldset">
  <fieldset><input id="in-nested-fieldset" aria-label="nested"></fieldset>
</fieldset>
<fieldset><input id="in-enabled-fieldset" aria-label="enabled"></fieldset>
<div aria-disabled="true"><div><button id="under-aria">c</button></div></div>
<div aria-disabled="false"><button id="under-aria-false">d</button></div>
<select aria-label="sel">
  <option id="option-plain">A</option>
  <option id="option-disabled" disabled>B</option>
  <optgroup label="off" disabled><option id="option-in-group">C</option></optgroup>
</select>
<select disabled aria-label="off"><option id="option-in-select">D</option></select>`;

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

test("a disabling container marks the controls it holds", async ({ page }) => {
  await setContent(page, DISABLED);
  const cdp = await page.createCDPSession();
  const ids = await backendIds(cdp);
  const nodes = (await cdp.send("Accessibility.getFullAXTree")).nodes;
  const state = (id: string): string => {
    const node = nodes.find((n) => n.backendDOMNodeId === ids.get(id));
    if (!node) throw new Error(`no AX node for #${id}`);
    const has = (name: string) => (node.properties ?? []).some((p) => String(p.name) === name);
    return `${has("disabled") ? "disabled" : "enabled"} ${has("focusable") ? "focusable" : "unfocusable"}`;
  };
  expect({
    inFirstLegend: state("in-first-legend"),
    inSecondLegend: state("in-second-legend"),
    inFieldset: state("in-fieldset"),
    inNestedFieldset: state("in-nested-fieldset"),
    inEnabledFieldset: state("in-enabled-fieldset"),
    underAria: state("under-aria"),
    underAriaFalse: state("under-aria-false"),
    optionPlain: state("option-plain"),
    optionDisabled: state("option-disabled"),
    optionInGroup: state("option-in-group"),
    optionInSelect: state("option-in-select"),
  }).toEqual({
    inFirstLegend: "enabled focusable",
    inSecondLegend: "disabled unfocusable",
    inFieldset: "disabled unfocusable",
    inNestedFieldset: "disabled unfocusable",
    inEnabledFieldset: "enabled focusable",
    underAria: "disabled focusable",
    underAriaFalse: "enabled focusable",
    optionPlain: "enabled focusable",
    optionDisabled: "disabled unfocusable",
    optionInGroup: "disabled unfocusable",
    optionInSelect: "disabled focusable",
  });
  await cdp.detach().catch(() => {});
}, 60_000);
