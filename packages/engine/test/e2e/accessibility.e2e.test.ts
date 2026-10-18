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

function byRole(nodes: AXNode[], role: string): AXNode[] {
  return nodes.filter((n) => !n.ignored && n.role?.value === role);
}
function byName(nodes: AXNode[], name: string): AXNode | undefined {
  return nodes.find((n) => !n.ignored && n.name?.value === name);
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

  const roots = nodes.filter((n) => n.role?.value === "RootWebArea");
  expect(roots.length).toBe(1);

  expect(byRole(nodes, "banner").length).toBe(1);
  expect(byRole(nodes, "navigation").length).toBe(1);
  expect(byRole(nodes, "main").length).toBe(1);
  expect(byRole(nodes, "contentinfo").length).toBe(1);

  const h1 = nodes.find((n) => n.role?.value === "heading" && n.name?.value === "Site Title");
  expect(h1).toBeTruthy();
  const level = h1?.properties?.find((p) => p.name === "level");
  expect(level?.value.value).toBe(1);

  expect(byName(nodes, "About us")).toBeTruthy();
  expect(byName(nodes, "Home")).toBeTruthy();

  const form = byRole(nodes, "form")[0];
  expect(form?.name?.value).toBe("Sign up");

  const email = nodes.find((n) => n.role?.value === "textbox" && n.name?.value === "Email address");
  expect(email).toBeTruthy();
  expect(email?.properties?.some((p) => p.name === "required" && p.value.value === true)).toBe(
    true,
  );

  const pw = nodes.find((n) => n.role?.value === "textbox" && n.name?.value === "Password");
  expect(pw).toBeTruthy();

  const freeRadio = nodes.find((n) => n.role?.value === "radio" && n.name?.value === "Free");
  const proRadio = nodes.find((n) => n.role?.value === "radio" && n.name?.value === "Pro");
  expect(freeRadio?.properties?.find((p) => p.name === "checked")?.value.value).toBe("true");
  expect(proRadio?.properties?.find((p) => p.name === "checked")?.value.value).toBe("false");

  const slider = byRole(nodes, "slider")[0];
  expect(slider).toBeTruthy();
  const min = slider?.properties?.find((p) => p.name === "valuemin");
  const max = slider?.properties?.find((p) => p.name === "valuemax");
  const now = slider?.properties?.find((p) => p.name === "valuenow");
  expect(min?.value.value).toBe(0);
  expect(max?.value.value).toBe(10);
  expect(now?.value.value).toBe(5);

  const cancel = nodes.find((n) => n.role?.value === "button" && n.name?.value === "Cancel");
  expect(cancel?.properties?.some((p) => p.name === "disabled" && p.value.value === true)).toBe(
    true,
  );

  const like = nodes.find((n) => n.role?.value === "button" && n.name?.value === "Like");
  expect(like?.properties?.find((p) => p.name === "pressed")?.value.value).toBe("false");

  const presentational = nodes.filter((n) =>
    n.ignoredReasons?.some((r) => r.name === "presentationalRole"),
  );
  expect(presentational.length).toBeGreaterThan(0);
  expect(presentational.every((n) => n.ignored && n.role?.value === "none")).toBe(true);

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
  const hiddenSelf = hidden.nodes.find((n) => n.backendDOMNodeId === hiddenId);
  expect(hiddenSelf).toBeTruthy();
  expect(hiddenSelf?.ignored).toBe(true);
  expect((hiddenSelf?.ignoredReasons ?? []).map((r) => r.name)).toContain("notRendered");

  const bareId = await sel("#y");
  const bare = (await session.send("Accessibility.getPartialAXTree", {
    backendNodeId: bareId,
    fetchRelatives: true,
  })) as { nodes: AXNode[] };
  const bareSelf = bare.nodes.find((n) => n.backendDOMNodeId === bareId);
  expect(bareSelf?.ignored).toBe(false);
  expect(bareSelf?.role?.value).toBe("generic");
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

  const reasons = (n: AXNode | undefined) => (n?.ignoredReasons ?? []).map((r) => r.name);
  const names = nodes.filter((n) => !n.ignored).map((n) => n.name?.value ?? "");
  const texts = nodes
    .filter((n) => !n.ignored && n.role?.value === "StaticText")
    .map((n) => String(n.name?.value ?? ""));

  const ignored = nodes.filter((n) => n.ignored);
  expect(ignored.length).toBeGreaterThan(0);
  for (const n of ignored) {
    expect(n.role?.value).toBe("none");
    expect(n.name).toBeUndefined();
    expect(n.properties).toBeUndefined();
  }

  const gone = nodes.find((n) => reasons(n).includes("notRendered"));
  expect(gone).toBeTruthy();
  expect(names).not.toContain("never-emitted-1");
  expect(names).not.toContain("never-emitted-2");
  expect(texts.join(" ")).not.toContain("never-emitted-3");

  expect(names).toContain("climbs-back");
  expect(names).not.toContain("also-hidden");

  const presentational = nodes.filter((n) => reasons(n).includes("presentationalRole"));
  expect(presentational.length).toBeGreaterThan(0);
  expect(texts.join(" ")).toContain("layout-cell-a");
  expect(byRole(nodes, "table").length).toBe(1);
  expect(byRole(nodes, "columnheader").length + byRole(nodes, "cell").length).toBeGreaterThan(0);

  const ahSelf = nodes.find((n) => reasons(n).includes("ariaHiddenElement"));
  expect(ahSelf).toBeTruthy();
  expect(names).not.toContain("inherited-hidden");

  const pop = nodes.find((n) => !n.ignored && n.name?.value === "Open menu");
  expect(pop?.properties?.find((p) => p.name === "hasPopup")?.value.value).toBe("menu");
  const popListbox = nodes.find((n) => !n.ignored && n.name?.value === "Choose");
  expect(popListbox?.properties?.find((p) => p.name === "hasPopup")?.value.value).toBe("listbox");

  expect(byRole(nodes, "generic").length).toBeGreaterThan(0);

  expect(texts).toContain("generic text");
  expect(texts).toContain("real text");
  expect(texts.some((t) => t.trim() === "")).toBe(false);

  expect(nodes.some((n) => reasons(n).includes("uninteresting"))).toBe(true);
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
