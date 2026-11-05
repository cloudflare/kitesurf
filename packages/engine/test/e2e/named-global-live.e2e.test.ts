// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const PAGE = `<main><p id="namedBox">one</p><p id="namedBox">duplicate</p></main><script>
  globalThis.readNamedBox = () => typeof namedBox === "undefined" ? null : namedBox.textContent;
</script>`;

test("bare named globals follow removal, duplicate IDs, and replacement", async ({ page }) => {
  await setContent(page, PAGE);
  const seen = await page.evaluate(() => {
    const read: unknown = Reflect.get(globalThis, "readNamedBox");
    if (typeof read !== "function") throw new Error("missing named-global reader");
    const out = [read()];
    document.getElementById("namedBox")?.remove();
    out.push(read());
    document.getElementById("namedBox")?.remove();
    out.push(read());
    const next = document.createElement("p");
    next.id = "namedBox";
    next.textContent = "two";
    document.body.appendChild(next);
    out.push(read());
    next.id = "renamedBox";
    out.push(read());
    return out;
  });
  expect(seen).toEqual(["one", "duplicate", null, "two", null]);
});

test("named global getter keeps its metadata and identity across duplicate owners", async ({
  page,
}) => {
  await setContent(
    page,
    `<p id="descriptorBox">one</p><script>
    const first = document.getElementById("descriptorBox");
    const getter = Object.getOwnPropertyDescriptor(globalThis, "descriptorBox")?.get;
    if (!first || !getter) throw new Error("missing named-global getter or node");
    let nonConstructible = false;
    try {
      Reflect.construct(Object, [], getter);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      nonConstructible = true;
    }
    const duplicate = document.createElement("p");
    duplicate.id = "descriptorBox";
    duplicate.textContent = "duplicate";
    document.body.appendChild(duplicate);
    const sameAfterDuplicate =
      Object.getOwnPropertyDescriptor(globalThis, "descriptorBox")?.get === getter;
    first.id = "renamedDescriptorBox";
    globalThis.namedGetterResult = {
      name: getter.name,
      length: getter.length,
      hasPrototype: Object.prototype.hasOwnProperty.call(getter, "prototype"),
      nonConstructible,
      sameAfterDuplicate,
      sameAfterRename: Object.getOwnPropertyDescriptor(globalThis, "descriptorBox")?.get === getter,
      valueAfterRename: getter()?.textContent,
    };
  </script>`,
  );
  const result = await page.evaluate(() => Reflect.get(globalThis, "namedGetterResult"));
  expect(result).toEqual({
    name: "getter",
    length: 0,
    hasPrototype: false,
    nonConstructible: true,
    sameAfterDuplicate: true,
    sameAfterRename: true,
    valueAfterRename: "duplicate",
  });
});

test("iframe IDs resolve to elements and frame names resolve to windows", async ({ page }) => {
  await setContent(
    page,
    `<iframe id="frameById" name="frameByName"></iframe><script>
    globalThis.readFrameGlobals = () => {
      const frame = document.getElementById("frameById");
      return {
        bareIdIsElement: frameById === frame,
        windowIdIsElement: window.frameById === frame,
        nameIsWindow: window.frameByName === frame.contentWindow,
        indexIsWindow: window[0] === frame.contentWindow,
      };
    };
  </script>`,
  );
  const result = await page.evaluate(() => {
    const read: unknown = Reflect.get(globalThis, "readFrameGlobals");
    if (typeof read !== "function") throw new Error("missing frame-global reader");
    return read();
  });
  expect(result).toEqual({
    bareIdIsElement: true,
    windowIdIsElement: true,
    nameIsWindow: true,
    indexIsWindow: true,
  });
});

test("a page assignment to a named global survives later ID changes", async ({ page }) => {
  await setContent(
    page,
    `<p id="assignedBox">one</p><script>
    assignedBox = 7;
    const node = document.getElementById("assignedBox");
    node.id = "renamedAssignedBox";
    node.id = "assignedBox";
    globalThis.assignedResult = [assignedBox, globalThis.assignedBox];
  </script>`,
  );
  expect(await page.evaluate(() => Reflect.get(globalThis, "assignedResult"))).toEqual([7, 7]);
});

test("cloned duplicate globals survive until the last owner is renamed", async ({ page }) => {
  await setContent(
    page,
    `<p id="clonedBox">one</p><script>
    globalThis.readClone = () => typeof clonedBox === "undefined" ? null : clonedBox.textContent;
  </script>`,
  );
  const value = await page.evaluate(() => {
    const read: unknown = Reflect.get(globalThis, "readClone");
    const first = document.getElementById("clonedBox");
    if (typeof read !== "function" || !first) throw new Error("missing named node");
    first.id = "clonedBox";
    first.id = "clonedBox";
    const clone = first.cloneNode(true);
    clone.textContent = "clone";
    document.body.appendChild(clone);
    first.id = "renamedClone";
    const afterFirstRename = read();
    if (!(clone instanceof Element)) throw new Error("clone is not an element");
    clone.id = "renamedDuplicate";
    return {
      afterFirstRename,
      afterLastRename: read(),
      accessorRemoved: Object.getOwnPropertyDescriptor(globalThis, "clonedBox") === undefined,
    };
  });
  expect(value).toEqual({
    afterFirstRename: "clone",
    afterLastRename: null,
    accessorRemoved: true,
  });
});

test("fragment IDs resolve after insertion without calling page selectors", async ({ page }) => {
  await setContent(
    page,
    `<main></main><script>
    globalThis.readFragmentBox = () => typeof fragmentBox === "undefined" ? null : fragmentBox.textContent;
  </script>`,
  );
  const result = await page.evaluate(() => {
    const read: unknown = Reflect.get(globalThis, "readFragmentBox");
    if (typeof read !== "function") throw new Error("missing named-global reader");
    const query = Element.prototype.querySelectorAll;
    const seen = [read()];
    let fragment: DocumentFragment;
    try {
      Element.prototype.querySelectorAll = () => {
        throw new Error("page selector called");
      };
      const range = document.createRange();
      range.selectNodeContents(document.body);
      fragment = range.createContextualFragment(
        '<p id="fragmentBox">fragment</p><p id="document">reserved</p>',
      );
    } finally {
      Element.prototype.querySelectorAll = query;
    }
    seen.push(read());
    document.body.appendChild(fragment);
    seen.push(read());
    return { seen, reserved: window.document === document };
  });
  expect(result).toEqual({ seen: [null, null, "fragment"], reserved: true });
});

test("page-defined globals are not deleted when their former node ID changes", async ({ page }) => {
  await setContent(
    page,
    `${PAGE}<script>
    Object.defineProperty(globalThis, "namedBox", { value: 7, writable: true, configurable: true });
    for (const node of document.querySelectorAll('[id="namedBox"]')) node.id = "renamedBox";
    globalThis.definedResult = [namedBox, globalThis.namedBox];
  </script>`,
  );
  expect(await page.evaluate(() => Reflect.get(globalThis, "definedResult"))).toEqual([7, 7]);
});

test("detached-only IDs do not create named globals", async ({ page }) => {
  await setContent(
    page,
    `<script>
    const probe = ([name, read]) => {
      let bare = "resolved";
      try { read(); } catch (error) { bare = error instanceof ReferenceError ? "ReferenceError" : String(error); }
      return { inWindow: name in window, inGlobal: name in globalThis, bare };
    };
    const host = document.createElement("div");
    host.innerHTML = '<p id="detachedHtml"></p>';
    const template = document.createElement("template");
    template.innerHTML = '<p id="templateOnly"></p>';
    const range = document.createRange();
    range.selectNodeContents(document.body);
    range.createContextualFragment('<p id="fragmentOnly"></p>');
    const created = document.createElement("p");
    created.id = "createdOnly";
    const namespaced = document.createElement("p");
    namespaced.setAttributeNS(null, "id", "namespacedOnly");
    globalThis.detachedResult = [
      ["detachedHtml", () => detachedHtml],
      ["templateOnly", () => templateOnly],
      ["fragmentOnly", () => fragmentOnly],
      ["createdOnly", () => createdOnly],
      ["namespacedOnly", () => namespacedOnly],
    ].map(probe);
  </script>`,
  );
  const absent = { inWindow: false, inGlobal: false, bare: "ReferenceError" };
  expect(await page.evaluate(() => Reflect.get(globalThis, "detachedResult"))).toEqual(
    Array(5).fill(absent),
  );
});
