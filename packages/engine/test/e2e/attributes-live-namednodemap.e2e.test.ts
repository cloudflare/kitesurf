// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
// https://opensource.org/licenses/Apache-2.0

import { expect, test } from "./harness";
import { setContent } from "./set-content";

const MARKUP = `<div id="t" class="c" data-x="1">x</div>
<script>
  const el = document.getElementById("t");
  const out = {};

  // One map object, read once, observed across every later mutation.
  const attrs = el.attributes;
  out.initial = Array.prototype.map.call(attrs, (a) => a.name);
  out.initialLength = attrs.length;

  el.removeAttribute("id");
  out.afterRemoveLength = attrs.length;
  out.afterRemoveFirst = attrs[0] && attrs[0].name;
  out.afterRemoveGetNamed = attrs.getNamedItem("id");
  out.afterRemoveItem = Array.prototype.map.call(attrs, (a) => a.name);

  el.setAttribute("data-y", "z");
  out.afterAddLength = attrs.length;
  out.afterAddGetNamed = attrs.getNamedItem("data-y") && attrs.getNamedItem("data-y").value;
  out.afterAddKeys = Object.keys(attrs).length;

  // React 19's releaseSingletonInstance drain loop, verbatim in shape.
  let iterations = 0;
  out.drainError = null;
  try {
    while (attrs.length) {
      if (++iterations > 20) break;
      el.removeAttributeNode(attrs[0]);
    }
  } catch (e) {
    out.drainError = String(e && e.name);
  }
  out.drainIterations = iterations;
  out.remaining = attrs.length;
  out.elementAttrNames = Array.prototype.map.call(el.attributes, (a) => a.name);

  window.__out = out;
</script>`;

test("el.attributes is a live NamedNodeMap across mutations", async ({ page }) => {
  await setContent(page, MARKUP);
  const r = await page.evaluate(
    () => (window as typeof window & { __out: Record<string, unknown> }).__out,
  );

  expect(r.initial).toEqual(["id", "class", "data-x"]);
  expect(r.initialLength).toBe(3);

  expect(r.afterRemoveLength).toBe(2);
  expect(r.afterRemoveFirst).toBe("class");
  expect(r.afterRemoveGetNamed).toBe(null);
  expect(r.afterRemoveItem).toEqual(["class", "data-x"]);

  expect(r.afterAddLength).toBe(3);
  expect(r.afterAddGetNamed).toBe("z");
  expect(r.afterAddKeys).toBe(3);

  expect(r.drainError).toBe(null);
  expect(r.drainIterations).toBe(3);
  expect(r.remaining).toBe(0);
  expect(r.elementAttrNames).toEqual([]);
});
