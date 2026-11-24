// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import type { CDPSession, Page } from "@cloudflare/puppeteer";
import type { Protocol } from "devtools-protocol";

import { expect, test } from "./harness";
import { setContent } from "./set-content";

type AXNode = Protocol.Accessibility.AXNode;
type SnapshotNode = NonNullable<Awaited<ReturnType<Page["accessibility"]["snapshot"]>>>;

const OPTIONS = `<!doctype html><title>Options</title>
<select aria-label="Sort">
  <option id="enabled">Sort by</option>
  <option id="disabled" disabled>Disabled</option>
  <option id="tabbed" disabled tabindex="0">Disabled with tabindex</option>
  <optgroup label="On"><option id="in-group">In enabled group</option></optgroup>
  <optgroup label="Off" disabled>
    <option id="in-disabled-group">In disabled group</option>
    <option id="tabbed-in-disabled-group" tabindex="0">Tabindex in disabled group</option>
  </optgroup>
</select>
<select aria-label="Off" disabled><option id="in-disabled-select">In disabled select</option></select>
<select aria-label="Many" multiple><option id="multiple">In multiple</option></select>
<select aria-label="List" size="3"><option id="sized">In sized</option></select>`;

async function tree(cdp: CDPSession): Promise<AXNode[]> {
  return (await cdp.send("Accessibility.getFullAXTree")).nodes;
}

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

test("an enabled option in a select is focusable in the AX tree", async ({ page }) => {
  await setContent(page, OPTIONS);
  const cdp = await page.createCDPSession();
  const ids = await backendIds(cdp);
  const nodes = await tree(cdp);
  const focusable = (id: string) => {
    const node = nodes.find((n) => n.backendDOMNodeId === ids.get(id));
    if (!node || node.ignored) throw new Error(`no AX node for #${id}`);
    expect(node.role?.value).toBe("option");
    const property = node.properties?.find((p) => String(p.name) === "focusable");
    if (property) expect(property.value).toEqual({ type: "booleanOrUndefined", value: true });
    return property !== undefined;
  };
  expect({
    enabled: focusable("enabled"),
    disabled: focusable("disabled"),
    tabbed: focusable("tabbed"),
    inGroup: focusable("in-group"),
    inDisabledGroup: focusable("in-disabled-group"),
    tabbedInDisabledGroup: focusable("tabbed-in-disabled-group"),
    inDisabledSelect: focusable("in-disabled-select"),
    multiple: focusable("multiple"),
    sized: focusable("sized"),
  }).toEqual({
    enabled: true,
    disabled: false,
    tabbed: false,
    inGroup: true,
    inDisabledGroup: false,
    tabbedInDisabledGroup: false,
    inDisabledSelect: true,
    multiple: true,
    sized: true,
  });
  await cdp.detach().catch(() => {});
}, 60_000);

function findRole(node: SnapshotNode | null, role: string): SnapshotNode | undefined {
  if (!node) return undefined;
  if (node.role === role) return node;
  for (const child of node.children ?? []) {
    const found = findRole(child, role);
    if (found) return found;
  }
  return undefined;
}

// Puppeteer's snapshot drops a child of a control unless the child is focusable.
test("the accessibility snapshot keeps a select's options", async ({ page }) => {
  await setContent(
    page,
    `<select aria-label="Sort"><option>Sort by</option><option>Price (Low - High)</option></select>`,
  );
  const combobox = findRole(await page.accessibility.snapshot(), "combobox");
  expect(combobox?.name).toBe("Sort");
  expect(combobox?.children?.map(({ role, name }) => ({ role, name }))).toEqual([
    { role: "option", name: "Sort by" },
    { role: "option", name: "Price (Low - High)" },
  ]);
}, 60_000);
