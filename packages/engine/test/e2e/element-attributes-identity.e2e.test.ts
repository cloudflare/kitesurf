// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

// Element wrappers of one name share an identity record and read attributes through
// attributeList; neither may leak state between elements or serve stale attributes.
import { expect, test } from "./harness";
import { setContent } from "./set-content";

const MARKUP = `<span id="s1" class="a">one</span><span id="s2">two</span><b></b><b></b>
<svg xmlns:xlink="http://www.w3.org/1999/xlink"><a id="sa" xlink:href="#h"></a></svg>
<a id="ha" href="#x">html</a><p id="p">x<i>y</i></p>
<details id="d"><summary id="sum">More</summary>Body</details>
<script>
  const out = {};
  const s1 = document.getElementById("s1"), s2 = document.getElementById("s2");
  const [b1, b2] = document.querySelectorAll("b");
  const sa = document.getElementById("sa"), ha = document.getElementById("ha");
  const XLINK = "http://www.w3.org/1999/xlink";

  out.names = [s1.tagName, s2.tagName, sa.tagName, ha.tagName, sa.localName, ha.localName];
  out.namespaces = [sa.namespaceURI, ha.namespaceURI];

  // The first attribute operation on this element is the namespaced read, with no list refresh
  // ahead of it: the sidecar must already be reachable.
  out.nsFirst = sa.getAttributeNS(XLINK, "href");

  // Attribute-less elements share one empty list; setting on one must not reach the other.
  out.bEmpty = [b1.hasAttributes(), b2.hasAttributes(), b1.attributes.length];
  b1.setAttribute("title", "t");
  out.bAfterSet = [b1.getAttribute("title"), b2.getAttribute("title"), b2.attributes.length];
  b1.removeAttribute("title");
  out.bAfterRemove = [b1.hasAttributes(), b1.getAttribute("title")];

  // One live map observed across set, overwrite and removal.
  const attrs = s1.attributes;
  out.initial = Array.prototype.map.call(attrs, (a) => a.name + "=" + a.value);
  s1.setAttribute("data-k", "v");
  s1.className = "b";
  out.afterSet = Array.prototype.map.call(attrs, (a) => a.name + "=" + a.value);
  s1.removeAttribute("id");
  out.afterRemove = [attrs.length, attrs.getNamedItem("id"), s1.getAttribute("class")];
  out.s2Untouched = [s2.id, s2.className, s2.attributes.length];
  out.dataset = [s1.dataset.k, s1.toggleAttribute("hidden"), s1.hasAttribute("hidden")];
  attrs.getNamedItem("data-k").value = "w";
  out.attrNodeWrite = s1.getAttribute("data-k");

  // Parsed namespaced attributes survive a refresh of the attribute list. Reading the list
  // first used to be required for getAttributeNS to see them.
  const nsRead = () => {
    const attr = sa.attributes[1];
    return [sa.getAttributeNS(XLINK, "href"), attr.name, attr.namespaceURI, attr.localName];
  };
  out.nsBefore = nsRead();
  sa.setAttribute("class", "c");
  out.nsAfter = nsRead();
  sa.setAttributeNS(XLINK, "xlink:href", "#j");
  out.nsSet = nsRead();

  // A re-parsed subtree gets fresh elements whose attributes are their own.
  const p = document.getElementById("p");
  out.textBefore = p.textContent;
  p.firstChild.data = "X";
  out.textAfterData = p.textContent;
  p.appendChild(document.createTextNode("z"));
  out.textAfterAppend = p.textContent;
  p.removeChild(p.querySelector("i"));
  out.textAfterRemove = p.textContent;
  p.innerHTML = '<i class="n">new</i><i>old</i>';
  const [n1, n2] = p.querySelectorAll("i");
  out.reparsed = [n1.className, n2.className, n2.hasAttributes(), p.textContent];

  window.__out = out;
</script>`;

type Out = Record<string, unknown>;

test("shared element identities keep per-element names, attributes and text", async ({ page }) => {
  await setContent(page, MARKUP);
  const r = await page.evaluate(() => (window as typeof window & { __out: Out }).__out);

  expect(r.names).toEqual(["SPAN", "SPAN", "a", "A", "a", "a"]);
  expect(r.namespaces).toEqual(["http://www.w3.org/2000/svg", "http://www.w3.org/1999/xhtml"]);
  expect(r.bEmpty).toEqual([false, false, 0]);
  expect(r.bAfterSet).toEqual(["t", null, 0]);
  expect(r.bAfterRemove).toEqual([false, null]);
  expect(r.initial).toEqual(["id=s1", "class=a"]);
  expect(r.afterSet).toEqual(["id=s1", "class=b", "data-k=v"]);
  expect(r.afterRemove).toEqual([2, null, "b"]);
  expect(r.s2Untouched).toEqual(["s2", "", 1]);
  expect(r.dataset).toEqual(["v", true, true]);
  expect(r.attrNodeWrite).toBe("w");
  const xlink = "http://www.w3.org/1999/xlink";
  expect(r.nsFirst).toBe("#h");
  expect(r.nsBefore).toEqual(["#h", "xlink:href", xlink, "href"]);
  expect(r.nsAfter).toEqual(["#h", "xlink:href", xlink, "href"]);
  expect(r.nsSet).toEqual(["#j", "xlink:href", xlink, "href"]);
  expect(r.textBefore).toBe("xy");
  expect(r.textAfterData).toBe("Xy");
  expect(r.textAfterAppend).toBe("Xyz");
  expect(r.textAfterRemove).toBe("Xz");
  expect(r.reparsed).toEqual(["n", "", false, "newold"]);
});

test("attribute writes from JS and from CDP input agree with the engine", async ({ page }) => {
  await setContent(page, MARKUP);
  const cdp = await page.createCDPSession();
  const { root } = (await cdp.send("DOM.getDocument", { depth: 0 })) as {
    root: { nodeId: number };
  };
  const attributesOf = async (selector: string): Promise<string[]> => {
    const { nodeId } = (await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    })) as { nodeId: number };
    const { attributes } = (await cdp.send("DOM.getAttributes", { nodeId })) as {
      attributes: string[];
    };
    return attributes;
  };

  // The engine sees the page's writes.
  expect(await attributesOf("#s2")).toEqual(["id", "s2"]);
  await page.evaluate(() => {
    const s2 = document.getElementById("s2");
    s2?.setAttribute("data-from-js", "1");
    s2?.removeAttribute("id");
  });
  expect(await attributesOf("span[data-from-js]")).toEqual(["data-from-js", "1"]);

  // A CDP click toggles <details open>; the page then reads the new attribute list.
  const readOpen = () =>
    page.evaluate(() => {
      const d = document.getElementById("d");
      return [d?.hasAttribute("open"), d?.attributes.length, d?.getAttribute("open")];
    });
  expect(await readOpen()).toEqual([false, 1, null]);
  await page.click("#sum");
  expect(await readOpen()).toEqual([true, 2, ""]);
  expect(await attributesOf("#d")).toEqual(["id", "d", "open", ""]);
  await page.click("#sum");
  expect(await readOpen()).toEqual([false, 1, null]);
});
