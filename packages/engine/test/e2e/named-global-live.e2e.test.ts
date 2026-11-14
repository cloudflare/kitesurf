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

test("named properties resolve lazily and stay out of the own-property surface", async ({
  page,
}) => {
  await setContent(
    page,
    `<p id="descriptorBox">one</p><script>
    const first = document.getElementById("descriptorBox");
    if (!first) throw new Error("missing named node");
    const read = () => typeof descriptorBox === "undefined" ? null : descriptorBox.textContent;
    const duplicate = document.createElement("p");
    duplicate.id = "descriptorBox";
    duplicate.textContent = "duplicate";
    document.body.appendChild(duplicate);
    const afterDuplicate = read();
    first.id = "renamedDescriptorBox";
    globalThis.namedDescriptorResult = {
      afterDuplicate,
      afterFirstRename: read(),
      ownDescriptor: Object.getOwnPropertyDescriptor(globalThis, "descriptorBox") === undefined,
      ownKey: Object.keys(globalThis).includes("descriptorBox"),
      inGlobal: "descriptorBox" in globalThis,
    };
  </script>`,
  );
  const result = await page.evaluate(() => Reflect.get(globalThis, "namedDescriptorResult"));
  expect(result).toEqual({
    afterDuplicate: "one",
    afterFirstRename: "duplicate",
    ownDescriptor: true,
    ownKey: false,
    inGlobal: true,
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
    // The same id written twice: the repeat write changes nothing.
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
      ownDescriptorAbsent: Object.getOwnPropertyDescriptor(globalThis, "clonedBox") === undefined,
    };
  });
  expect(value).toEqual({
    afterFirstRename: "clone",
    afterLastRename: null,
    ownDescriptorAbsent: true,
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

// A Proxy in the global's prototype chain made V8 resolve an unresolvable reference through its
// `set` trap, so strict code created a global instead of throwing ReferenceError.
test("strict code throws for an undeclared assignment beside a named global", async ({ page }) => {
  await setContent(
    page,
    `<p id="strictNamedBox">one</p><script>
    globalThis.strictResult = {
      named: typeof strictNamedBox === "undefined" ? null : strictNamedBox.textContent,
    };
    try { (function () { "use strict"; strictUndeclared = 1; })(); strictResult.classicThrew = false; }
    catch (error) { strictResult.classicThrew = error instanceof ReferenceError; }
    strictResult.classicCreated = Object.prototype.hasOwnProperty.call(globalThis, "strictUndeclared");
    strictUndeclaredSloppy = 1;
    strictResult.sloppyCreated = Object.prototype.hasOwnProperty.call(globalThis, "strictUndeclaredSloppy");
  </script>
  <script type="module">
    try { moduleUndeclared = 1; globalThis.strictResult.moduleThrew = false; }
    catch (error) { globalThis.strictResult.moduleThrew = error instanceof ReferenceError; }
  </script>`,
  );
  await expect
    .poll(
      async () =>
        (await page.evaluate(
          "globalThis.strictResult ? globalThis.strictResult.moduleThrew : null",
        )) as boolean | null,
      { timeout: 20_000 },
    )
    .not.toBeNull();
  const result = JSON.parse(
    (await page.evaluate("JSON.stringify(globalThis.strictResult)")) as string,
  );
  expect(result).toEqual({
    named: "one",
    classicThrew: true,
    classicCreated: false,
    sloppyCreated: true,
    moduleThrew: true,
  });
}, 60_000);

// A named property is writable in Chrome, so an assignment replaces it with an own data property
// on the global while the element stays connected.
test("an assignment to a named global makes an own property", async ({ page }) => {
  await setContent(
    page,
    `<p id="assignedStrictBox">one</p><p id="assignedSloppyBox">two</p><script>
    const descriptor = (name) => {
      const desc = Object.getOwnPropertyDescriptor(globalThis, name);
      return desc ? [desc.value, desc.writable, desc.enumerable, desc.configurable] : null;
    };
    globalThis.assignResult = {};
    try { (function () { "use strict"; assignedStrictBox = "strict"; })(); assignResult.strictError = null; }
    catch (error) { assignResult.strictError = error && error.name ? String(error.name) : String(error); }
    assignResult.strictOwn = descriptor("assignedStrictBox");
    assignResult.strictRead = assignedStrictBox;
    assignedSloppyBox = "sloppy";
    assignResult.sloppyOwn = descriptor("assignedSloppyBox");
    assignResult.sloppyRead = assignedSloppyBox;
    assignResult.stillConnected = document.getElementById("assignedStrictBox") !== null &&
      document.getElementById("assignedSloppyBox") !== null;
  </script>`,
  );
  const result = JSON.parse(
    (await page.evaluate("JSON.stringify(globalThis.assignResult)")) as string,
  );
  expect(result).toEqual({
    strictError: null,
    strictOwn: ["strict", true, true, true],
    strictRead: "strict",
    sloppyOwn: ["sloppy", true, true, true],
    sloppyRead: "sloppy",
    stillConnected: true,
  });
}, 60_000);

// The bare-read probe: a name with no accessor on the named properties object resolves to
// nothing, so reading it throws ReferenceError again.
const BARE_READ = `
  const bareRead = (read) => {
    try { read(); return "resolved"; }
    catch (error) { return error instanceof ReferenceError ? "ReferenceError" : String(error); }
  };
`;

// Moving a connected element into a detached tree leaves the document, so its name must go with
// it: `in` false, and the bare read throws again.
test("a move into a detached parent drops the name", async ({ page }) => {
  await setContent(
    page,
    `<main><p id="fragAppendBox">a</p><p id="fragInsertBox">b</p><p id="rangeDeleteBox">c</p></main>
    <script>${BARE_READ}
    globalThis.movedResult = (() => {
      const fragment = document.createDocumentFragment();
      fragment.appendChild(document.getElementById("fragAppendBox"));
      const detachedHost = document.createElement("div");
      detachedHost.insertBefore(document.getElementById("fragInsertBox"), null);
      const range = document.createRange();
      range.selectNode(document.getElementById("rangeDeleteBox"));
      range.deleteContents();
      return {
        appended: { inWindow: "fragAppendBox" in window, bare: bareRead(() => fragAppendBox) },
        inserted: { inWindow: "fragInsertBox" in window, bare: bareRead(() => fragInsertBox) },
        ranged: { inWindow: "rangeDeleteBox" in window, bare: bareRead(() => rangeDeleteBox) },
      };
    })();
  </script>`,
  );
  const gone = { inWindow: false, bare: "ReferenceError" };
  expect(await page.evaluate(() => Reflect.get(globalThis, "movedResult"))).toEqual({
    appended: gone,
    inserted: gone,
    ranged: gone,
  });
});

// Whether another owner remains is a wasm id-map question: a page that replaces
// document.getElementById cannot answer it, and an element is an owner whether or not the page
// can still find it.
test("a page-replaced getElementById does not drop a name another owner keeps", async ({
  page,
}) => {
  await setContent(
    page,
    `<main><p id="dupGid">one</p><p id="dupGid">two</p></main><script>
    globalThis.dupResult = (() => {
      const owners = document.querySelectorAll('[id="dupGid"]');
      if (owners.length !== 2) throw new Error("expected two owners, saw " + owners.length);
      document.getElementById = () => null;
      owners[0].remove();
      return { inWindow: "dupGid" in window, type: typeof dupGid };
    })();
  </script>`,
  );
  expect(await page.evaluate(() => Reflect.get(globalThis, "dupResult"))).toEqual({
    inWindow: true,
    type: "object",
  });
});

// A page can freeze the named properties object. The mutation must still apply and report its
// connected side effect instead of throwing a TypeError from the accessor install.
test("a frozen named properties object does not make a mutation throw", async ({ page }) => {
  await setContent(
    page,
    `<main><p id="frozenHost">host</p></main><script>
    globalThis.frozenResult = (() => {
      Object.preventExtensions(Object.getPrototypeOf(globalThis));
      const out = { idError: null, appendError: null };
      const el = document.createElement("p");
      try { el.id = "frozenBox"; } catch (error) { out.idError = String(error && error.name); }
      try { document.body.appendChild(el); } catch (error) { out.appendError = String(error && error.name); }
      out.idApplied = el.getAttribute("id");
      out.connected = el.isConnected;
      out.found = document.getElementById("frozenBox") === el;
      return out;
    })();
  </script>`,
  );
  expect(await page.evaluate(() => Reflect.get(globalThis, "frozenResult"))).toEqual({
    idError: null,
    appendError: null,
    idApplied: "frozenBox",
    connected: true,
    found: true,
  });
});

// Chrome never exposes a shadow-tree id, and a shadow tree is not part of the document's id
// space, so neither innerHTML nor appendChild inside a root may install a name.
test("shadow-tree ids never become named globals", async ({ page }) => {
  await setContent(
    page,
    `<main></main><script>
    globalThis.shadowResult = (() => {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = '<span id="shadowOnly"></span>';
      const span = document.createElement("b");
      span.id = "shadowAppended";
      root.appendChild(span);
      const before = { inner: "shadowOnly" in window, appended: "shadowAppended" in window };
      host.remove();
      const after = { inner: "shadowOnly" in window, appended: "shadowAppended" in window };
      return { before, after };
    })();
  </script>`,
  );
  const absent = { inner: false, appended: false };
  expect(await page.evaluate(() => Reflect.get(globalThis, "shadowResult"))).toEqual({
    before: absent,
    after: absent,
  });
});

// HTML lowercases attribute names, so markup that spells the attribute ID still names the element.
test("markup with an uppercase ID attribute installs the name", async ({ page }) => {
  await setContent(
    page,
    `<main><div id="upperHost"></div></main><script>
    globalThis.upperResult = (() => {
      const host = document.getElementById("upperHost");
      host.innerHTML = '<span ID="upperBox">upper</span>';
      const el = document.getElementById("upperBox");
      return {
        inWindow: "upperBox" in window,
        sameNode: typeof upperBox === "undefined" ? null : upperBox === el,
        text: typeof upperBox === "undefined" ? null : upperBox.textContent,
      };
    })();
  </script>`,
  );
  expect(await page.evaluate(() => Reflect.get(globalThis, "upperResult"))).toEqual({
    inWindow: true,
    sameNode: true,
    text: "upper",
  });
});

// Each of the three replacement paths detaches the old child, so its name must go with it.
test("innerHTML, outerHTML and textContent replacement drop the replaced name", async ({
  page,
}) => {
  await setContent(
    page,
    `<main></main><script>${BARE_READ}
    globalThis.replaceResult = (() => {
      const connectedHost = () => {
        const host = document.createElement("div");
        document.body.appendChild(host);
        return host;
      };

      const innerHost = connectedHost();
      innerHost.innerHTML = '<p id="innerReplaced">x</p>';
      const innerInstalled = "innerReplaced" in window;
      innerHost.innerHTML = "<em>gone</em>";
      const inner = {
        installed: innerInstalled,
        after: "innerReplaced" in window,
        bare: bareRead(() => innerReplaced),
      };

      const outerHost = connectedHost();
      outerHost.innerHTML = '<p id="outerReplaced">y</p>';
      const outerInstalled = "outerReplaced" in window;
      document.getElementById("outerReplaced").outerHTML = "<i>gone</i>";
      const outer = {
        installed: outerInstalled,
        after: "outerReplaced" in window,
        bare: bareRead(() => outerReplaced),
      };

      const textHost = connectedHost();
      textHost.innerHTML = '<p id="textReplaced">z</p>';
      const textInstalled = "textReplaced" in window;
      textHost.textContent = "";
      const text = {
        installed: textInstalled,
        after: "textReplaced" in window,
        bare: bareRead(() => textReplaced),
      };

      return { inner, outer, text };
    })();
  </script>`,
  );
  const gone = { installed: true, after: false, bare: "ReferenceError" };
  expect(await page.evaluate(() => Reflect.get(globalThis, "replaceResult"))).toEqual({
    inner: gone,
    outer: gone,
    text: gone,
  });
});
