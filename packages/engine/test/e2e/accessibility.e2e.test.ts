// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";

interface AXValue {
  type: string;
  value?: unknown;
}
interface AXNode {
  nodeId: string;
  ignored: boolean;
  ignoredReasons?: Array<{ name: string; value: AXValue }>;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: Array<{ name: string; value: AXValue }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId: number;
}

function roleValue(node: AXNode | undefined): unknown {
  return node?.role?.value;
}

function nameValue(node: AXNode | undefined): unknown {
  return node?.name?.value;
}

function nodeNameOrEmpty(node: AXNode): unknown {
  return nameValue(node) ?? "";
}

function byRoleAndName(nodes: AXNode[], role: string, name: string): AXNode | undefined {
  return nodes.find((node) => roleValue(node) === role && nameValue(node) === name);
}

function propertyValue(node: AXNode | undefined, name: string): unknown {
  const property = node?.properties?.find((entry) => entry.name === name);
  return property?.value.value;
}

function hasPropertyValue(
  node: AXNode | undefined,
  name: string,
  value: unknown,
): boolean | undefined {
  return node?.properties?.some((entry) => entry.name === name && entry.value.value === value);
}

function ignoredReasonNames(node: AXNode | undefined): string[] {
  return (node?.ignoredReasons ?? []).map((reason) => reason.name);
}

function hasIgnoredReason(node: AXNode, reason: string): boolean {
  return ignoredReasonNames(node).includes(reason);
}

function byIgnoredReason(nodes: AXNode[], reason: string): AXNode | undefined {
  return nodes.find((node) => hasIgnoredReason(node, reason));
}

function isPresentationalNode(node: AXNode): boolean {
  return hasIgnoredReason(node, "presentationalRole");
}

function expectIgnoredNodeShape(node: AXNode): void {
  expect(node.role?.value).toBe("none");
  expect(node.name).toBeUndefined();
  expect(node.properties).toBeUndefined();
}

function isPrunedNode(node: AXNode): boolean {
  return node.ignored && roleValue(node) === "none";
}

function byRole(nodes: AXNode[], role: string): AXNode[] {
  return nodes.filter((node) => !node.ignored && roleValue(node) === role);
}
function byName(nodes: AXNode[], name: string): AXNode | undefined {
  return nodes.find((node) => !node.ignored && nameValue(node) === name);
}

test("Accessibility.getFullAXTree exposes role + name for landmarks and controls", async ({
  page,
}) => {
  await page.goto("https://ks.invalid/__fixtures/accessibility.html", {
    waitUntil: "domcontentloaded",
  });
  const session = await page.createCDPSession();
  await session.send("Accessibility.enable");
  const { nodes } = (await session.send("Accessibility.getFullAXTree")) as {
    nodes: AXNode[];
  };

  const roots = nodes.filter((node) => roleValue(node) === "RootWebArea");
  expect(roots.length).toBe(1);

  expect(byRole(nodes, "banner").length).toBe(1);
  expect(byRole(nodes, "navigation").length).toBe(1);
  expect(byRole(nodes, "main").length).toBe(1);
  expect(byRole(nodes, "contentinfo").length).toBe(1);

  const h1 = byRoleAndName(nodes, "heading", "Site Title");
  expect(h1).toBeTruthy();
  expect(propertyValue(h1, "level")).toBe(1);

  expect(byName(nodes, "About us")).toBeTruthy();
  expect(byName(nodes, "Home")).toBeTruthy();

  const form = byRole(nodes, "form")[0];
  expect(form?.name?.value).toBe("Sign up");

  const email = byRoleAndName(nodes, "textbox", "Email address");
  expect(email).toBeTruthy();
  expect(hasPropertyValue(email, "required", true)).toBe(true);

  const pw = byRoleAndName(nodes, "textbox", "Password");
  expect(pw).toBeTruthy();

  const freeRadio = byRoleAndName(nodes, "radio", "Free");
  const proRadio = byRoleAndName(nodes, "radio", "Pro");
  expect(propertyValue(freeRadio, "checked")).toBe("true");
  expect(propertyValue(proRadio, "checked")).toBe("false");

  const slider = byRole(nodes, "slider")[0];
  expect(slider).toBeTruthy();
  expect(propertyValue(slider, "valuemin")).toBe(0);
  expect(propertyValue(slider, "valuemax")).toBe(10);
  expect(propertyValue(slider, "valuenow")).toBe(5);

  const cancel = byRoleAndName(nodes, "button", "Cancel");
  expect(hasPropertyValue(cancel, "disabled", true)).toBe(true);

  const like = byRoleAndName(nodes, "button", "Like");
  expect(propertyValue(like, "pressed")).toBe("false");

  const presentational = nodes.filter(isPresentationalNode);
  expect(presentational.length).toBeGreaterThan(0);
  expect(presentational.every(isPrunedNode)).toBe(true);

  expect(byRole(nodes, "alert").length).toBe(1);
}, 120_000);

test("Accessibility.queryAXTree filters by role and accessible name", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/accessibility.html", {
    waitUntil: "domcontentloaded",
  });
  const session = await page.createCDPSession();
  await session.send("Accessibility.enable");

  const byRoleReply = (await session.send("Accessibility.queryAXTree", {
    role: "button",
  })) as { nodes: AXNode[] };
  const buttonNames = byRoleReply.nodes.map((n) => n.name?.value ?? "");
  expect(buttonNames).toEqual(
    expect.arrayContaining(["Create account", "Cancel", "Like", "Retry"]),
  );

  const byNameReply = (await session.send("Accessibility.queryAXTree", {
    accessibleName: "Sign up",
  })) as { nodes: AXNode[] };
  expect(byNameReply.nodes.length).toBeGreaterThanOrEqual(1);
  const roles = new Set(byNameReply.nodes.map((n) => n.role?.value));
  expect(roles.has("form") || roles.has("heading")).toBe(true);
}, 120_000);

test("Accessibility.getPartialAXTree on an ignored element surfaces ignoredReasons (DevTools side panel)", async ({
  cdpSession: session,
}) => {
  const tree = (await session.send("Page.getFrameTree")) as {
    frameTree: { frame: { id: string } };
  };
  await session.send("Page.setDocumentContent", {
    frameId: tree.frameTree.frame.id,
    html: "<!doctype html><div id=x style='display:none'>hidden</div><div id=y>bare</div>",
  });
  const { root } = (await session.send("DOM.getDocument")) as { root: { nodeId: number } };
  const sel = async (selector: string) =>
    (
      (await session.send("DOM.querySelector", { nodeId: root.nodeId, selector })) as {
        nodeId: number;
      }
    ).nodeId;

  const hiddenId = await sel("#x");
  const hidden = (await session.send("Accessibility.getPartialAXTree", {
    backendNodeId: hiddenId,
    fetchRelatives: true,
  })) as { nodes: AXNode[] };
  const hiddenSelf = hidden.nodes.find((node) => node.backendDOMNodeId === hiddenId);
  expect(hiddenSelf).toBeTruthy();
  expect(hiddenSelf?.ignored).toBe(true);
  expect(ignoredReasonNames(hiddenSelf)).toContain("notRendered");

  const bareId = await sel("#y");
  const bare = (await session.send("Accessibility.getPartialAXTree", {
    backendNodeId: bareId,
    fetchRelatives: true,
  })) as { nodes: AXNode[] };
  const bareSelf = bare.nodes.find((node) => node.backendDOMNodeId === bareId);
  expect(bareSelf?.ignored).toBe(false);
  expect(roleValue(bareSelf)).toBe("generic");
}, 120_000);

test("Accessibility.getPartialAXTree returns subtree + ancestors", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/accessibility.html", {
    waitUntil: "domcontentloaded",
  });
  const session = await page.createCDPSession();
  await session.send("Accessibility.enable");
  const { root } = (await session.send("DOM.getDocument")) as {
    root: { nodeId: number };
  };
  const { nodeId } = (await session.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "form",
  })) as { nodeId: number };
  expect(nodeId).toBeGreaterThan(0);

  const partial = (await session.send("Accessibility.getPartialAXTree", {
    backendNodeId: nodeId,
    fetchRelatives: true,
  })) as { nodes: AXNode[] };
  const roles = partial.nodes.map((n) => n.role?.value);
  expect(roles).toEqual(
    expect.arrayContaining(["form", "textbox", "button", "checkbox", "radio", "slider"]),
  );
  expect(roles).toContain("main");
  expect(roles).toContain("RootWebArea");
}, 120_000);

test("Accessibility.getFullAXTree matches Chrome's ignored/pruned tree shape", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/accessibility-parity.html", {
    waitUntil: "domcontentloaded",
  });
  const session = await page.createCDPSession();
  await session.send("Accessibility.enable");
  const { nodes } = (await session.send("Accessibility.getFullAXTree")) as {
    nodes: AXNode[];
  };

  const names = nodes.filter((node) => !node.ignored).map(nodeNameOrEmpty);
  const texts = nodes
    .filter((node) => !node.ignored && roleValue(node) === "StaticText")
    .map((node) => String(nodeNameOrEmpty(node)));

  const ignored = nodes.filter((n) => n.ignored);
  expect(ignored.length).toBeGreaterThan(0);
  ignored.forEach(expectIgnoredNodeShape);

  const gone = byIgnoredReason(nodes, "notRendered");
  expect(gone).toBeTruthy();
  expect(names).not.toContain("never-emitted-1");
  expect(names).not.toContain("never-emitted-2");
  expect(texts.join(" ")).not.toContain("never-emitted-3");

  expect(names).toContain("climbs-back");
  expect(names).not.toContain("also-hidden");

  const presentational = nodes.filter(isPresentationalNode);
  expect(presentational.length).toBeGreaterThan(0);
  expect(texts.join(" ")).toContain("layout-cell-a");
  expect(byRole(nodes, "table").length).toBe(1);
  expect(byRole(nodes, "columnheader").length + byRole(nodes, "cell").length).toBeGreaterThan(0);

  const ahSelf = byIgnoredReason(nodes, "ariaHiddenElement");
  expect(ahSelf).toBeTruthy();
  expect(names).not.toContain("inherited-hidden");

  const pop = byName(nodes, "Open menu");
  expect(propertyValue(pop, "hasPopup")).toBe("menu");
  const popListbox = byName(nodes, "Choose");
  expect(propertyValue(popListbox, "hasPopup")).toBe("listbox");

  expect(byRole(nodes, "generic").length).toBeGreaterThan(0);

  expect(texts).toContain("generic text");
  expect(texts).toContain("real text");
  expect(texts.some((t) => t.trim() === "")).toBe(false);

  expect(nodes.some((node) => hasIgnoredReason(node, "uninteresting"))).toBe(true);
}, 120_000);

test("Accessibility.getFullAXTree computes url, focusable, level and keyshortcuts", async ({
  page,
}) => {
  const pageUrl = "https://ks.invalid/__fixtures/accessibility-parity.html";
  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
  const session = await page.createCDPSession();
  await session.send("Accessibility.enable");
  const { nodes } = (await session.send("Accessibility.getFullAXTree")) as {
    nodes: AXNode[];
  };
  const prop = (n: AXNode | undefined, name: string) =>
    n?.properties?.find((p) => p.name === name)?.value.value;
  const named = (name: string) => nodes.find((n) => !n.ignored && n.name?.value === name);
  const { root: domRoot } = (await session.send("DOM.getDocument")) as {
    root: { nodeId: number };
  };
  const axFor = async (selector: string) => {
    const { nodeId } = (await session.send("DOM.querySelector", {
      nodeId: domRoot.nodeId,
      selector,
    })) as { nodeId: number };
    return nodes.find((n) => n.backendDOMNodeId === nodeId);
  };

  const root = nodes.find((n) => n.role?.value === "RootWebArea");
  expect(prop(root, "url")).toBe(pageUrl);

  expect(prop(named("Relative link"), "url")).toBe("https://ks.invalid/relative/path?q=1");
  expect(prop(named("Logo"), "url")).toBe("https://ks.invalid/img/logo.png");

  expect(prop(named("Shortcut link"), "keyshortcuts")).toBe("Ctrl+Alt+k");

  expect(prop(await axFor("#outer"), "level")).toBe(1);
  expect(prop(await axFor("#inner"), "level")).toBe(2);

  expect(prop(named("Relative link"), "focusable")).toBe(true);
  expect(prop(await axFor("#tabdiv"), "focusable")).toBe(true);
  expect(prop(await axFor("#offbtn"), "focusable")).toBeUndefined();
  expect(
    nodes.some((n) =>
      (n.properties ?? []).some((p) => p.value.value === false && p.name === "focusable"),
    ),
  ).toBe(false);

  const pop = named("Open menu");
  expect(prop(pop, "hasPopup")).toBe("menu");
  expect((pop?.properties ?? []).some((p) => p.name === "haspopup")).toBe(false);
}, 120_000);

test("Accessibility.getFullAXTree reports live value/checked, not attributes", async ({ page }) => {
  await page.goto("https://ks.invalid/__fixtures/accessibility.html", {
    waitUntil: "domcontentloaded",
  });
  const session = await page.createCDPSession();

  await page.evaluate(() => {
    const email = document.querySelector("#email") as HTMLInputElement;
    email.value = "typed@example.com";
    const tos = document.querySelector('input[name="tos"]') as HTMLInputElement;
    tos.checked = true;
    const pro = document.querySelector('input[value="pro"]') as HTMLInputElement;
    pro.checked = true;
  });

  const { nodes } = (await session.send("Accessibility.getFullAXTree")) as {
    nodes: AXNode[];
  };
  const ctl = (role: string, name: string) =>
    nodes.find((n) => !n.ignored && n.role?.value === role && n.name?.value === name);
  const checkedOf = (n: AXNode | undefined) =>
    n?.properties?.find((p) => p.name === "checked")?.value.value;

  expect(ctl("textbox", "Email address")?.value?.value).toBe("typed@example.com");

  expect(checkedOf(ctl("checkbox", "Accept terms"))).toBe("true");

  expect(checkedOf(ctl("radio", "Pro"))).toBe("true");
  expect(checkedOf(ctl("radio", "Free"))).toBe("false");
}, 120_000);
